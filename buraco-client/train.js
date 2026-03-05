import { Client } from 'boardgame.io/client';
import { BuracoGame } from './src/game.js';
import fs from 'fs';
import path from 'path';

// DNA SIZE: 608 inputs * 16 hidden nodes + 16 biases + 16 output weights + 1 output bias = 9761
const DNA_SIZE = 9761; 
const BOTS_DIR = path.join(process.cwd(), 'bots');

// Ensure the bots directory exists for saving DNA
if (!fs.existsSync(BOTS_DIR)) {
    fs.mkdirSync(BOTS_DIR, { recursive: true });
}

// Track running training sessions to prevent overlaps
const activeTrainings = new Map();

// Initialize with random small weights between -0.5 and 0.5
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

function runMatch(genomes, rules) {
    const client = Client({
        game: BuracoGame,
        numPlayers: rules.numPlayers || 4,
        setupData: { 
            ...rules,
            botGenomes: genomes 
        }
    });

    client.start();
    let state = client.getState();
    let moveCount = 0;
    const MAX_MOVES = 800; 

    while (!state.ctx.gameover && moveCount < MAX_MOVES) {
        const moves = BuracoGame.ai.enumerate(state.G, state.ctx);
        if (moves && moves.length > 0) {
            client.moves[moves[0].move](...moves[0].args);
        } else {
            client.events.endTurn();
        }
        state = client.getState();
        moveCount++;
    }

    if (!state.ctx.gameover) {
        return { team0: { total: -5000 }, team1: { total: -5000 } };
    }

    return state.ctx.gameover.scores;
}

export const TrainerService = {
    
    // Fetch a bot's current weights
    getBotWeights: (botName) => {
        const filePath = path.join(BOTS_DIR, `${botName}.json`);
        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf-8');
            return JSON.parse(data);
        }
        return null;
    },

    // Check if a bot is currently training
    getTrainingStatus: (botName) => {
        if (activeTrainings.has(botName)) {
            return { isTraining: true, progress: activeTrainings.get(botName) };
        }
        return { isTraining: false, progress: null };
    },

    // Async Training Loop triggered via API
    startTraining: async (botName, rules = {}, params = {}) => {
        if (activeTrainings.has(botName)) {
            throw new Error(`Training is already in progress for bot: ${botName}`);
        }

        const POPULATION_SIZE = params.populationSize || 24;
        const GENERATIONS = params.generations || 500;
        const MATCHES_PER_GENERATION = params.matchesPerGeneration || 12;

        activeTrainings.set(botName, { currentGeneration: 0, totalGenerations: GENERATIONS, bestScore: 0 });

        // Try to load existing DNA as a seed to continue training where we left off
        const seedDNA = TrainerService.getBotWeights(botName);
        let population;
        
        if (seedDNA) {
            console.log(`🧠 Resuming training for '${botName}' from existing DNA...`);
            // Clone the champion, then fill the rest of the population with mutations of it
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

                for (let botId = 0; botId < POPULATION_SIZE; botId++) {
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
                        
                        // Pass dynamic rules here
                        const scores = runMatch(matchGenomes, rules);
                        fitnessScores[botId] += scores.team0.total; 
                    }
                }

                const averageFitness = fitnessScores.map(score => score / MATCHES_PER_GENERATION);
                
                const rankedBots = population
                    .map((genome, index) => ({ genome, score: averageFitness[index] }))
                    .sort((a, b) => b.score - a.score);

                const bestScore = rankedBots[0].score;
                console.log(`[${botName}] Gen ${gen}/${GENERATIONS} | Best: ${bestScore.toFixed(0)} pts`);

                // Update status for the frontend
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

                // Save Champion DNA periodically and at the very end
                if (gen % 5 === 0 || gen === GENERATIONS) {
                    const filePath = path.join(BOTS_DIR, `${botName}.json`);
                    fs.writeFileSync(filePath, JSON.stringify(rankedBots[0].genome));
                }
                
                // Yield to the event loop so the server doesn't freeze during heavy training
                await new Promise(resolve => setTimeout(resolve, 10)); 
            }
        } catch (error) {
            console.error(`Error during training for ${botName}:`, error);
        } finally {
            console.log(`✅ Training complete for '${botName}'!`);
            activeTrainings.delete(botName);
        }
    }
};

train();
