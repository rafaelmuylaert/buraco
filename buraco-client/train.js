import { Client } from 'boardgame.io/client';
import { BuracoGame } from './src/game.js';

// 1. THE ML BASE GENOME (Neural Network Weights)
// All weights start at 0. The algorithm will quickly learn which ones should be positive (rewards) or negative (penalties).
const BASE_GENOME = {
    // Pickup Features
    pickup_base: 0, pickup_clean: 0, pickup_dirty: 0, pickup_onlyCopy: 0, pickup_pileSize: 0, pickup_panic: 0,
    
    // Meld Features
    meld_base: 0, meld_finishesCanasta: 0, meld_grabsMorto: 0, meld_isWild: 0, meld_isSuitedTwo: 0, meld_isDirty: 0, meld_panic: 0,
    
    // Discard Action Features
    discard_base: 0, discard_isWild: 0, discard_isSafeRepeat: 0, discard_givesOppCanasta: 0, discard_standardDenial: 0, 
    discard_knownCardDenial: 0, discard_hasPair: 0, discard_hasNeighbor: 0, discard_panic: 0,
    
    // Discard Rank Features (Intrinsic values)
    discard_rank_3: 0, discard_rank_4: 0, discard_rank_5: 0, discard_rank_6: 0, 
    discard_rank_7: 0, discard_rank_8: 0, discard_rank_9: 0, discard_rank_10: 0, 
    discard_rank_J: 0, discard_rank_Q: 0, discard_rank_K: 0, discard_rank_A: 0
};

// 2. GENETICS ENGINE (Mutation & Breeding for ML Weights)
function mutate(genome, mutationRate = 0.2, maxStep = 5.0) {
    const mutated = JSON.parse(JSON.stringify(genome)); // Deep copy
    for (let key in mutated) {
        if (Math.random() < mutationRate) {
            // Because weights can be 0, we ADD a random step between -maxStep and +maxStep
            const shift = (Math.random() * 2 - 1) * maxStep;
            mutated[key] += shift;
        }
    }
    return mutated;
}

function breed(parentA, parentB) {
    const child = {};
    // Flat crossover: randomly take each weight from Parent A or Parent B
    for (let key in BASE_GENOME) {
        child[key] = Math.random() > 0.5 ? parentA[key] : parentB[key];
    }
    return mutate(child);
}

// 3. THE SIMULATOR (Runs a single headless match at lightspeed)
function runMatch(genomes) {
    const client = Client({
        game: BuracoGame,
        numPlayers: 4,
        setupData: { 
            numPlayers: 4, discard: 'closed', runners: 'aces_kings', 
            largeCanasta: true, cleanCanastaToWin: true, noJokers: false, 
            botGenomes: genomes // Inject the DNA here!
        }
    });

    client.start();
    let state = client.getState();
    let moveCount = 0;
    const MAX_MOVES = 800; // Prevent infinite loops if bots evolve into cowards

    while (!state.ctx.gameover && moveCount < MAX_MOVES) {
        const moves = BuracoGame.ai.enumerate(state.G, state.ctx);
        
        if (moves && moves.length > 0) {
            const bestMove = moves[0]; // The ML model already sorted them
            client.moves[bestMove.move](...bestMove.args);
        } else {
            // If the bot gets stuck/hallucinates, force pass to avoid infinite loop
            client.events.endTurn();
        }
        
        state = client.getState();
        moveCount++;
    }

    if (!state.ctx.gameover) {
        // Match timed out (Bots evolved to never draw/discard to avoid mistakes). Return heavy penalty scores.
        return { team0: { total: -5000 }, team1: { total: -5000 } };
    }

    return state.ctx.gameover.scores;
}

// 4. THE EVOLUTIONARY LOOP
async function train() {
    const POPULATION_SIZE = 20;
    const GENERATIONS = 500;
    const MATCHES_PER_GENERATION = 15; // Increased slightly to average out the luck of ML bots

    console.log("🧬 Initializing ML Bot Population...");
    // Start with heavy mutation (step size 10.0) so the initial weights spread out quickly
    let population = Array(POPULATION_SIZE).fill(null).map(() => mutate(BASE_GENOME, 0.5, 10.0)); 

    for (let gen = 1; gen <= GENERATIONS; gen++) {
        console.log(`\n⚔️ --- GENERATION ${gen} ---`);
        let fitnessScores = Array(POPULATION_SIZE).fill(0);

        // Every bot plays several matches
        for (let botId = 0; botId < POPULATION_SIZE; botId++) {
            for (let m = 0; m < MATCHES_PER_GENERATION; m++) {
                // Pick 3 random opponents from the population
                const opponents = [
                    Math.floor(Math.random() * POPULATION_SIZE),
                    Math.floor(Math.random() * POPULATION_SIZE),
                    Math.floor(Math.random() * POPULATION_SIZE)
                ];
                
                // Seat 0 and 2 are Team 0. Seat 1 and 3 are Team 1.
                // We put our target bot in Seat 0 (Team 0).
                const matchGenomes = {
                    '0': population[botId],
                    '1': population[opponents[0]],
                    '2': population[opponents[1]],
                    '3': population[opponents[2]]
                };

                const scores = runMatch(matchGenomes);
                
                // Add Team 0's total score to our Bot's fitness
                fitnessScores[botId] += scores.team0.total; 
            }
        }

        // Calculate average score per bot
        const averageFitness = fitnessScores.map(score => score / MATCHES_PER_GENERATION);
        
        // Sort bots by fitness (Highest score first)
        const rankedBots = population
            .map((genome, index) => ({ genome, score: averageFitness[index] }))
            .sort((a, b) => b.score - a.score);

        console.log(`🏆 Best Bot Score: ${rankedBots[0].score.toFixed(0)} pts`);
        console.log(`💀 Worst Bot Score: ${rankedBots[POPULATION_SIZE - 1].score.toFixed(0)} pts`);

        // SURVIVAL OF THE FITTEST: Keep top 4 (Elites), kill the rest
        const elites = rankedBots.slice(0, 4).map(b => b.genome);
        
        let newPopulation = [...elites]; // Elites survive untouched

        // BREEDING: Create 16 children by crossing over random elites
        while (newPopulation.length < POPULATION_SIZE) {
            const parentA = elites[Math.floor(Math.random() * elites.length)];
            const parentB = elites[Math.floor(Math.random() * elites.length)];
            newPopulation.push(breed(parentA, parentB));
        }

        population = newPopulation;

        // Print the DNA of the current champion every 10 generations!
        if (gen % 10 === 0 || gen === GENERATIONS) {
            console.log(`\n👑 Champion DNA (Gen ${gen}):`);
            
            // Format the weights nicely to 2 decimal places for readability
            const prettyDNA = {};
            for (const key in rankedBots[0].genome) {
                prettyDNA[key] = parseFloat(rankedBots[0].genome[key].toFixed(2));
            }
            console.log(JSON.stringify(prettyDNA, null, 2));
        }
    }
}

train();
