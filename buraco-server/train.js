import { Client } from 'boardgame.io/dist/cjs/client.js';
import { BuracoGame } from './game.js';
import fs from 'fs';
import path from 'path';

// DNA SIZE: 12417 per stage * 4 stages = 49668
const DNA_SIZE = 49668; 
const BOTS_DIR = path.join(process.cwd(), 'bots');

if (!fs.existsSync(BOTS_DIR)) {
    fs.mkdirSync(BOTS_DIR, { recursive: true });
}

const activeTrainings = new Map();

//const generateRandomGenome = () => Array.from({ length: DNA_SIZE }, () => (Math.random() - 0.5));

function mutate(genome, mutationRate = 0.1, maxStep = 0.5) {
    const mutated = new Float32Array(genome);
    for (let i = 0; i < DNA_SIZE; i++) {
        if (Math.random() < mutationRate) {
            mutated[i] += (Math.random() * 2 - 1) * maxStep;
        }
    }
    return mutated;
}

function breed(parentA, parentB) {
    const child = new Float32Array(DNA_SIZE);
    for (let i = 0; i < DNA_SIZE; i++) {
        child[i] = Math.random() > 0.5 ? parentA[i] : parentB[i];
    }
    return mutate(child);
}

const generateRandomGenome = () => {
    const g = new Float32Array(DNA_SIZE);
    for (let i = 0; i < DNA_SIZE; i++) g[i] = (Math.random() - 0.5);
    return g;
};

function runMatch(genomes, rules) {
    const client = Client({
        game: BuracoGame,
        numPlayers: rules.numPlayers || 4,
        setupData: { ...rules },
        debug: false,
    });

    client.start();
    try {
        let state = client.getState();
        let moveCount = 0;
        const MAX_MOVES = 800;
        let lastMoveKey = null;

        while (!state.ctx.gameover && moveCount < MAX_MOVES) {
            const p = state.ctx.currentPlayer;
            const moves = BuracoGame.ai.enumerate(state.G, state.ctx, genomes[p]);

            if (!moves || moves.length === 0) {
                if (!state.ctx.gameover) client.events.endTurn();
                state = client.getState();
                lastMoveKey = null;
                moveCount++;
                continue;
            }

            const nextMove = moves[0];
            const moveKey = `${nextMove.move}:${(nextMove.args || []).flat().join(',')}`;

            if (moveKey === lastMoveKey) {
                client.events.endTurn();
                state = client.getState();
                lastMoveKey = null;
                moveCount++;
                continue;
            }

            lastMoveKey = moveKey;
            client.moves[nextMove.move](...(nextMove.args || []));
            state = client.getState();
            if (state.ctx.gameover) break;
            moveCount++;
        }

        return state.ctx.gameover
            ? state.ctx.gameover.scores
            : { team0: { total: -5000 }, team1: { total: -5000 } };
    } catch (e) {
        console.error('[TRAINER] runMatch crashed:', e.message);
        return { team0: { total: -5000 }, team1: { total: -5000 } };
    } finally {
        client.stop();
    }
}

export const TrainerService = {
    
    getBotWeights: (botName) => {
        const filePath = path.join(BOTS_DIR, `${botName}.json`);
        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf-8');
            return JSON.parse(data);
        }
        return null;
    },

    getTrainingStatus: (botName) => {
        if (activeTrainings.has(botName)) {
            return { isTraining: true, progress: activeTrainings.get(botName) };
        }
        return { isTraining: false, progress: null };
    },

    startTraining: async (botName, rules = {}, params = {}) => {
        if (activeTrainings.has(botName)) {
            throw new Error(`Training is already in progress for bot: ${botName}`);
        }

        const POPULATION_SIZE = params.populationSize || 24;
        const GENERATIONS = params.generations || 500;
        const MATCHES_PER_GENERATION = params.matchesPerGeneration || 12;

        activeTrainings.set(botName, { currentGeneration: 0, totalGenerations: GENERATIONS, bestScore: 0 });

        const seedDNA = TrainerService.getBotWeights(botName);
        let population;
        
        if (seedDNA) {
            console.log(`🧠 Resuming training for '${botName}' from existing DNA...`);
            population = Array(POPULATION_SIZE).fill(null).map((_, idx) => {
                let activeDNA = seedDNA;
                
                // 🚀 SEAMLESS UPGRADE: Automatically upgrades old 9k or 12k brains to 49k 4-stage brains
                if (activeDNA.length !== DNA_SIZE) {
                    let expanded = [];
                    // Keep duplicating the old DNA array until it's large enough
                    while(expanded.length < DNA_SIZE) {
                        expanded.push(...activeDNA);
                    }
                    // Trim off any excess to ensure it's exactly 49668
                    activeDNA = expanded.slice(0, DNA_SIZE);
                }
                
                if (idx === 0) return activeDNA;
                return mutate(activeDNA, 0.2, 0.5); 
            });
        } else {
            console.log(`🧠 Starting fresh training for new 4-Stage bot '${botName}'...`);
            population = Array(POPULATION_SIZE).fill(null).map(() => generateRandomGenome());
        }

        try {
            for (let gen = 1; gen <= GENERATIONS; gen++) {
                let fitnessScores = Array(POPULATION_SIZE).fill(0);

                for (let botId = 0; botId < POPULATION_SIZE; botId++) {
                    await new Promise(resolve => setImmediate(resolve));
                    for (let m = 0; m < MATCHES_PER_GENERATION; m++) {
                        const opps = [ 
                            Math.floor(Math.random() * POPULATION_SIZE), 
                            Math.floor(Math.random() * POPULATION_SIZE), 
                            Math.floor(Math.random() * POPULATION_SIZE) 
                        ];
                        
                        const matchGenomes = { 
                            '0': population[botId], 
                            '1': population[opps[0]], 
                            '2': population[opps[1]], 
                            '3': population[opps[2]] 
                        };
                        
                        try {
                            const scores = runMatch(matchGenomes, rules);
                            fitnessScores[botId] += scores.team0.total;
                        } catch (e) {
                            console.error(`[TRAINER] Match skipped due to error:`, e.message);
                            fitnessScores[botId] += -5000;
                        }
                    }
                }

                const averageFitness = fitnessScores.map(score => score / MATCHES_PER_GENERATION);
                
                const rankedBots = population
                    .map((genome, index) => ({ genome, score: averageFitness[index] }))
                    .sort((a, b) => b.score - a.score);

                const bestScore = rankedBots[0].score;
                console.log(`[${botName}] Gen ${gen}/${GENERATIONS} | Best: ${bestScore.toFixed(0)} pts`);

                activeTrainings.set(botName, { 
                    currentGeneration: gen, 
                    totalGenerations: GENERATIONS, 
                    bestScore: bestScore 
                });

                const elites = rankedBots.slice(0, 4).map(b => b.genome);
                let newPopulation = [...elites]; 

                while (newPopulation.length < POPULATION_SIZE) {
                    newPopulation.push(breed(
                        elites[Math.floor(Math.random() * elites.length)], 
                        elites[Math.floor(Math.random() * elites.length)]
                    ));
                }
                population = newPopulation;

                if (gen % 25 === 0 || gen === GENERATIONS) {
                    const filePath = path.join(BOTS_DIR, `${botName}.json`);
                    fs.writeFileSync(filePath, JSON.stringify(rankedBots[0].genome));
                }
                
                await new Promise(resolve => setImmediate(resolve));
            }
        } catch (error) {
            console.error(`Error during training for ${botName}:`, error);
        } finally {
            console.log(`✅ Training complete for '${botName}'!`);
            activeTrainings.delete(botName);
        }
    }
};
