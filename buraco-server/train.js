import { Client } from 'boardgame.io/dist/cjs/client.js';
import { BuracoGame } from './game.js';
import fs from 'fs';
import path from 'path';

const DNA_SIZE = 9761; 
const BOTS_DIR = path.join(process.cwd(), 'bots');

if (!fs.existsSync(BOTS_DIR)) {
    fs.mkdirSync(BOTS_DIR, { recursive: true });
}

const activeTrainings = new Map();

const generateRandomGenome = () => Array.from({ length: DNA_SIZE }, () => (Math.random() - 0.5));

function mutate(genome, mutationRate = 0.1, maxStep = 0.5) {
    const mutated = [...genome];
    for (let i = 0; i < DNA_SIZE; i++) {
        if (Math.random() < mutationRate) {
            mutated[i] += (Math.random() * 2 - 1) * maxStep;
        }
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

function runMatch(genomes, rules, seed) {
    const client = Client({
        game: BuracoGame,
        numPlayers: rules.numPlayers || 4,
        matchID: seed, 
        setupData: { 
            ...rules
        }
    });

    client.start();
    let state = client.getState();
    let moveCount = 0;
    const MAX_MOVES = 800; 

    while (!state.ctx.gameover && moveCount < MAX_MOVES) {
        const currentPlayer = state.ctx.currentPlayer;
        const currentDNA = genomes[currentPlayer];
        
        const moves = BuracoGame.ai.enumerate(state.G, state.ctx, currentDNA);
        
        if (moves && moves.length > 0) {
            client.moves[moves[0].move](...moves[0].args);
        } else {
            client.events.endTurn();
        }
        state = client.getState();
        moveCount++;
    }

    client.stop();

    if (!state.ctx.gameover) {
        return { team0: { total: -5000 }, team1: { total: -5000 } };
    }

    return state.ctx.gameover.scores;
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
        // CHANGED: Default to the perfect 24 (4!) matches
        const MATCHES_PER_GENERATION = params.matchesPerGeneration || 24; 

        activeTrainings.set(botName, { currentGeneration: 0, totalGenerations: GENERATIONS, bestScore: 0 });

        const seedDNA = TrainerService.getBotWeights(botName);
        let population;
        
        if (seedDNA) {
            console.log(`🧠 Resuming training for '${botName}' from existing DNA...`);
            population = Array(POPULATION_SIZE).fill(null).map((_, idx) => {
                if (idx === 0) return seedDNA;
                return mutate(seedDNA, 0.2, 0.5); 
            });
        } else {
            console.log(`🧠 Starting fresh training for new bot '${botName}'...`);
            population = Array(POPULATION_SIZE).fill(null).map(() => generateRandomGenome());
        }

        try {
            for (let gen = 1; gen <= GENERATIONS; gen++) {
                let fitnessScores = Array(POPULATION_SIZE).fill(0);

                const generationSeeds = Array.from({ length: MATCHES_PER_GENERATION }, () => Math.random().toString());

                // 1. SHUFFLE THE POPULATION INTO GROUPS OF 4
                let botIndices = Array.from({ length: POPULATION_SIZE }, (_, i) => i);
                botIndices = botIndices.sort(() => Math.random() - 0.5);
                const NUM_TABLES = Math.floor(POPULATION_SIZE / 4);

                // ALL 24 SEATING PERMUTATIONS (4!)
                const SEAT_PERMUTATIONS = [
                    [0,1,2,3], [0,1,3,2], [0,2,1,3], [0,2,3,1], [0,3,1,2], [0,3,2,1],
                    [1,0,2,3], [1,0,3,2], [1,2,0,3], [1,2,3,0], [1,3,0,2], [1,3,2,0],
                    [2,0,1,3], [2,0,3,1], [2,1,0,3], [2,1,3,0], [2,3,0,1], [2,3,1,0],
                    [3,0,1,2], [3,0,2,1], [3,1,0,2], [3,1,2,0], [3,2,0,1], [3,2,1,0]
                ];

                // 2. RUN THE TABLES
                for (let table = 0; table < NUM_TABLES; table++) {
                    await new Promise(resolve => setTimeout(resolve, 0)); 

                    const tableBots = [
                        botIndices[table * 4],
                        botIndices[table * 4 + 1],
                        botIndices[table * 4 + 2],
                        botIndices[table * 4 + 3]
                    ];

                    for (let m = 0; m < MATCHES_PER_GENERATION; m++) {
                        const matchGenomes = {};
                        
                        // PERFECT ROTATION: Look up the permutation layout (loops safely if m > 23)
                        const perm = SEAT_PERMUTATIONS[m % 24];
                        
                        const p0 = tableBots[perm[0]];
                        const p1 = tableBots[perm[1]];
                        const p2 = tableBots[perm[2]];
                        const p3 = tableBots[perm[3]];

                        matchGenomes['0'] = population[p0];
                        matchGenomes['1'] = population[p1];
                        matchGenomes['2'] = population[p2];
                        matchGenomes['3'] = population[p3];
                        
                        const scores = runMatch(matchGenomes, rules, generationSeeds[m]);
                        
                        // CAPTURE ALL 4 SCORES!
                        fitnessScores[p0] += scores.team0.total; 
                        fitnessScores[p2] += scores.team0.total; 
                        fitnessScores[p1] += scores.team1.total;
                        fitnessScores[p3] += scores.team1.total;
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

                // 3. GLOBAL TRUNCATION SELECTION (The absolute 4 best mathematically breed the next generation)
                const elites = rankedBots.slice(0, 4).map(b => b.genome);
                let newPopulation = [...elites]; 

                while (newPopulation.length < POPULATION_SIZE) {
                    newPopulation.push(breed(
                        elites[Math.floor(Math.random() * elites.length)], 
                        elites[Math.floor(Math.random() * elites.length)]
                    ));
                }
                population = newPopulation;

                if (gen % 5 === 0 || gen === GENERATIONS) {
                    const filePath = path.join(BOTS_DIR, `${botName}.json`);
                    fs.writeFileSync(filePath, JSON.stringify(rankedBots[0].genome));
                }
            }
        } catch (error) {
            console.error(`Error during training for ${botName}:`, error);
        } finally {
            console.log(`✅ Training complete for '${botName}'!`);
            activeTrainings.delete(botName);
        }
    }
};
