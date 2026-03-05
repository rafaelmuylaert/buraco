import { Client } from 'boardgame.io/client';
import { BuracoGame } from './src/game.js';
import fs from 'fs';

// DNA SIZE: 608 inputs * 16 hidden nodes + 16 biases + 16 output weights + 1 output bias = 9761
const DNA_SIZE = 9761; 

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
    // Uniform crossover: randomly pick each weight from either parent
    for (let i = 0; i < DNA_SIZE; i++) {
        child[i] = Math.random() > 0.5 ? parentA[i] : parentB[i];
    }
    return mutate(child);
}

function runMatch(genomes) {
    const client = Client({
        game: BuracoGame,
        numPlayers: 4,
        setupData: { 
            numPlayers: 4, discard: 'closed', runners: 'aces_kings', 
            largeCanasta: true, cleanCanastaToWin: true, noJokers: false, 
            botGenomes: genomes // Inject the massive ML arrays here!
        }
    });

    client.start();
    let state = client.getState();
    let moveCount = 0;
    const MAX_MOVES = 800; // Hard cutoff to prevent infinite loops if bots evolve to be completely passive

    while (!state.ctx.gameover && moveCount < MAX_MOVES) {
        // AI Enumerate will now run the 9761-weight neural network calculation under the hood
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
        // Match timed out. The bots were too cowardly and refused to discard/meld. 
        // Return a massive penalty to aggressively breed this behavior out of the gene pool.
        return { team0: { total: -5000 }, team1: { total: -5000 } };
    }

    return state.ctx.gameover.scores;
}

async function train() {
    const POPULATION_SIZE = 24;
    const GENERATIONS = 500;
    const MATCHES_PER_GENERATION = 12;

    console.log("🧠 Initializing Deep Q-Network Bot Population...");
    let population = Array(POPULATION_SIZE).fill(null).map(() => generateRandomGenome()); 

    for (let gen = 1; gen <= GENERATIONS; gen++) {
        console.log(`\n⚔️ --- GENERATION ${gen} ---`);
        let fitnessScores = Array(POPULATION_SIZE).fill(0);

        // Every bot plays several matches to average out the luck of the deck
        for (let botId = 0; botId < POPULATION_SIZE; botId++) {
            for (let m = 0; m < MATCHES_PER_GENERATION; m++) {
                // Pick 3 random opponents from the population
                const opps = [ 
                    Math.floor(Math.random() * POPULATION_SIZE), 
                    Math.floor(Math.random() * POPULATION_SIZE), 
                    Math.floor(Math.random() * POPULATION_SIZE) 
                ];
                
                // Seat 0 and 2 are Team 0. Seat 1 and 3 are Team 1.
                // Put our evaluating bot in Seat 0.
                const matchGenomes = { 
                    '0': population[botId], 
                    '1': population[opps[0]], 
                    '2': population[opps[1]], 
                    '3': population[opps[2]] 
                };
                
                const scores = runMatch(matchGenomes);
                fitnessScores[botId] += scores.team0.total; 
            }
        }

        const averageFitness = fitnessScores.map(score => score / MATCHES_PER_GENERATION);
        
        // Sort bots by fitness (Highest score first)
        const rankedBots = population
            .map((genome, index) => ({ genome, score: averageFitness[index] }))
            .sort((a, b) => b.score - a.score);

        console.log(`🏆 Best Bot Score: ${rankedBots[0].score.toFixed(0)} pts`);
        console.log(`💀 Worst Bot Score: ${rankedBots[POPULATION_SIZE - 1].score.toFixed(0)} pts`);

        // SURVIVAL OF THE FITTEST: Keep the top 4 elite performers
        const elites = rankedBots.slice(0, 4).map(b => b.genome);
        let newPopulation = [...elites]; 

        // BREEDING
        while (newPopulation.length < POPULATION_SIZE) {
            newPopulation.push(breed(
                elites[Math.floor(Math.random() * elites.length)], 
                elites[Math.floor(Math.random() * elites.length)]
            ));
        }
        population = newPopulation;

        // SAVE CHAMPION DNA: Export to file instead of console due to massive size
        if (gen % 5 === 0 || gen === GENERATIONS) {
            fs.writeFileSync('champion_dna.json', JSON.stringify(rankedBots[0].genome));
            console.log(`💾 Champion DNA saved to 'champion_dna.json'!`);
        }
    }
}

train();
