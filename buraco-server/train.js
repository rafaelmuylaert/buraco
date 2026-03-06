import { Client } from 'boardgame.io/dist/cjs/client.js';
import { BuracoGame } from './game.js';
import fs from 'fs';
import path from 'path';

// EXACT ARCHITECTURE SIZE: 774 inputs * 16 hidden + 16 biases + 16 output + 1 output bias = 12417 weights!
const DNA_SIZE = 12417; 
const BOTS_DIR = path.join(process.cwd(), 'bots');

if (!fs.existsSync(BOTS_DIR)) fs.mkdirSync(BOTS_DIR, { recursive: true });

const activeTrainings = new Map();

const generateRandomGenome = () => Array.from({ length: DNA_SIZE }, () => (Math.random() - 0.5));

function mutate(genome, mutationRate = 0.1, maxStep = 0.5) {
    const mutated = [...genome];
    for (let i = 0; i < DNA_SIZE; i++) {
        if (Math.random() < mutationRate) mutated[i] += (Math.random() * 2 - 1) * maxStep;
    }
    return mutated;
}

function breed(parentA, parentB) {
    const child = new Array(DNA_SIZE);
    for (let i = 0; i < DNA_SIZE; i++) {
        child[i] = Math.random() > 0.5 ? parentA[i] : parentB[i];
    }
    return mutate(child);
}

// THE PLAYOFF DUEL
function runDuel(botA_DNA, botB_DNA, rules, seed, useTelepathy) {
    let client = Client({
        game: BuracoGame,
        numPlayers: rules.numPlayers || 4,
        matchID: seed, 
        debug: false, 
        setupData: { ...rules }
    });

    client.start();
    let state = client.getState();
    let moveCount = 0;
    const MAX_MOVES = 800; 

    while (!state.ctx.gameover && moveCount < MAX_MOVES) {
        const p = state.ctx.currentPlayer;
        const currentDNA = (p === '0' || p === '2') ? botA_DNA : botB_DNA;
        
        let aiG = state.G;
        
        // 🔮 TELEPATHY INJECTION (Only executed during training loop)
        if (useTelepathy && rules.numPlayers === 4) {
            const partnerId = (parseInt(p) + 2) % 4;
            aiG = {
                ...state.G,
                knownCards: {
                    ...state.G.knownCards,
                    [p]: [...(state.G.knownCards[p] || [])],
                    [partnerId.toString()]: [...(state.G.hands[partnerId.toString()] || [])] // Complete sync
                }
            };
        }
        
        const moves = BuracoGame.ai.enumerate(aiG, state.ctx, currentDNA);
        if (moves && moves.length > 0) {
            client.moves[moves[0].move](...moves[0].args);
        } else {
            client.events.endTurn();
        }
        state = client.getState();
        moveCount++;
    }

    const finalScores = state.ctx.gameover ? state.ctx.gameover.scores : { team0: { total: -2000 }, team1: { total: -2000 } };
    
    client.stop();
    client = null;
    state = null;

    return finalScores;
}

export const TrainerService = {
    getBotWeights: (botName) => {
        const filePath = path.join(BOTS_DIR, `${botName}.json`);
        if (fs.existsSync(filePath)) {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            if (data.length === DNA_SIZE) return data;
        }
        return null;
    },

    getTrainingStatus: (botName) => {
        if (activeTrainings.has(botName)) return { isTraining: true, progress: activeTrainings.get(botName) };
        return { isTraining: false, progress: null };
    },

    startTraining: async (botName, rules = {}, params = {}) => {
        if (activeTrainings.has(botName)) throw new Error(`Training already in progress for: ${botName}`);

        const POPULATION_SIZE = params.populationSize || 24;
        const GENERATIONS = params.generations || 500;
        const SAVE_INTERVAL = params.saveInterval || 10; 

        activeTrainings.set(botName, { currentGeneration: 0, totalGenerations: GENERATIONS });

        const seedDNA = TrainerService.getBotWeights(botName);
        let population;
        
        if (seedDNA) {
            console.log(`🧠 Resuming training for '${botName}' from existing DNA...`);
            population = Array(POPULATION_SIZE).fill(null).map((_, idx) => idx === 0 ? seedDNA : mutate(seedDNA, 0.2, 0.5));
        } else {
            console.log(`🧠 Starting fresh training for new bot '${botName}'...`);
            population = Array(POPULATION_SIZE).fill(null).map(() => generateRandomGenome());
        }

        const originalBot = [...population[0]];
        let benchmarkDiff = 0;

        try {
            for (let gen = 1; gen <= GENERATIONS; gen++) {
                let stats = Array(POPULATION_SIZE).fill(null).map(() => ({ diff: 0, points: 0, matches: 0 }));

                let botIndices = Array.from({ length: POPULATION_SIZE }, (_, i) => i).sort(() => Math.random() - 0.5);
                const pools = [[], [], [], []];
                botIndices.forEach((botId, i) => pools[i % 4].push(botId));

                for (let p = 0; p < 4; p++) {
                    const pool = pools[p];
                    for (let i = 0; i < pool.length; i++) {
                        for (let j = i + 1; j < pool.length; j++) {
                            await new Promise(resolve => setTimeout(resolve, 0));
                            
                            const botA = pool[i]; const botB = pool[j];
                            
                            const seed1 = Math.random().toString();
                            const scores1 = runDuel(population[botA], population[botB], rules, seed1, params.telepathy);
                            stats[botA].diff += (scores1.team0.total - scores1.team1.total);
                            stats[botA].points += scores1.team0.total; stats[botA].matches++;
                            
                            stats[botB].diff += (scores1.team1.total - scores1.team0.total);
                            stats[botB].points += scores1.team1.total; stats[botB].matches++;

                            const seed2 = Math.random().toString();
                            const scores2 = runDuel(population[botB], population[botA], rules, seed2, params.telepathy);
                            stats[botB].diff += (scores2.team0.total - scores2.team1.total);
                            stats[botB].points += scores2.team0.total; stats[botB].matches++;
                            
                            stats[botA].diff += (scores2.team1.total - scores2.team0.total);
                            stats[botA].points += scores2.team1.total; stats[botA].matches++;
                        }
                    }
                }

                let elites = [];
                pools.forEach(pool => {
                    pool.sort((a, b) => (stats[b].diff / stats[b].matches) - (stats[a].diff / stats[a].matches));
                    elites.push(population[pool[0]]);
                });

                const allAvgDiff = stats.reduce((sum, s) => sum + (s.diff / s.matches), 0) / POPULATION_SIZE;
                const allAvgPoints = stats.reduce((sum, s) => sum + (s.points / s.matches), 0) / POPULATION_SIZE;
                const globalBestIdx = botIndices.sort((a, b) => (stats[b].diff / stats[b].matches) - (stats[a].diff / stats[a].matches))[0];
                const maxDiff = stats[globalBestIdx].diff / stats[globalBestIdx].matches;
                const maxPoints = stats[globalBestIdx].points / stats[globalBestIdx].matches;

                if (gen % SAVE_INTERVAL === 0 || gen === GENERATIONS) {
                    const bScores1 = runDuel(elites[0], originalBot, rules, Math.random().toString(), params.telepathy);
                    const bScores2 = runDuel(originalBot, elites[0], rules, Math.random().toString(), params.telepathy);
                    
                    const d1 = bScores1.team0.total - bScores1.team1.total;
                    const d2 = bScores2.team1.total - bScores2.team0.total;
                    benchmarkDiff = (d1 + d2) / 2;

                    const filePath = path.join(BOTS_DIR, `${botName}.json`);
                    fs.writeFileSync(filePath, JSON.stringify(elites[0]));
                    console.log(`💾 Saved Weights. Gen ${gen} | Elite Diff vs Original: ${benchmarkDiff > 0 ? '+' : ''}${benchmarkDiff.toFixed(0)}`);
                }

                activeTrainings.set(botName, { 
                    currentGeneration: gen, totalGenerations: GENERATIONS, 
                    maxPoints, avgPoints: allAvgPoints, maxDiff, avgDiff: allAvgDiff, benchmarkDiff 
                });

                let newPopulation = [];
                elites.forEach(e => newPopulation.push([...e])); 
                elites.forEach(e => newPopulation.push(mutate(e, 0.1, 0.5))); 
                
                while (newPopulation.length < POPULATION_SIZE) {
                    let p1 = elites[Math.floor(Math.random() * 4)];
                    let p2 = elites[Math.floor(Math.random() * 4)];
                    newPopulation.push(breed(p1, p2)); 
                }
                population = newPopulation;
            }
        } catch (error) {
            console.error(`Error during training for ${botName}:`, error);
        } finally {
            console.log(`✅ Training complete for '${botName}'!`);
            activeTrainings.delete(botName);
        }
    }
};
