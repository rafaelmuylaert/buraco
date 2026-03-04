import { Client } from 'boardgame.io/client';
import { BuracoGame } from './src/game.js';

// 1. THE BASE DNA (Our starting point)
const BASE_GENOME = {
    wildcardHoldValue: -200,
    suitedTwoBonus: 80,
    finishCanastaBonus: 1000,
    grabMortoBonus: 2000,
    dirtyMeldPenalty: -300,
    dirtyMeldPanicBonus: 100,
    safeRepeatBonus: 200,
    oppCanastaDenialPenalty: -10000,
    standardDenialPenalty: -800,
    knownCardDenial: -3000,
    panicModeDiscardBonus: 50,
    intrinsic: { '3': 60, '4': 40, '5': 20, '6': -30, '7': -40, '8': -40, '9': -20, '10': 0, 'J': 10, 'Q': 20, 'K': -30, 'A': -30 }
};

// 2. GENETICS ENGINE (Mutation & Breeding)
function mutate(genome, mutationRate = 0.1) {
    const mutated = JSON.parse(JSON.stringify(genome)); // Deep copy
    for (let key in mutated) {
        if (key === 'intrinsic') {
            for (let rank in mutated.intrinsic) {
                if (Math.random() < mutationRate) {
                    // Shift the value up or down by up to 30%
                    mutated.intrinsic[rank] += mutated.intrinsic[rank] * (Math.random() * 0.6 - 0.3);
                }
            }
        } else {
            if (Math.random() < mutationRate) {
                mutated[key] += mutated[key] * (Math.random() * 0.6 - 0.3);
            }
        }
    }
    return mutated;
}

function breed(parentA, parentB) {
    const child = JSON.parse(JSON.stringify(BASE_GENOME));
    for (let key in child) {
        if (key === 'intrinsic') {
            for (let rank in child.intrinsic) {
                child.intrinsic[rank] = Math.random() > 0.5 ? parentA.intrinsic[rank] : parentB.intrinsic[rank];
            }
        } else {
            child[key] = Math.random() > 0.5 ? parentA[key] : parentB[key];
        }
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
        const p = state.ctx.currentPlayer;
        const moves = BuracoGame.ai.enumerate(state.G, state.ctx);
        
        if (moves && moves.length > 0) {
            const bestMove = moves[0]; // The enumerate function already sorts them
            client.moves[bestMove.move](...bestMove.args);
        } else {
            // If the bot gets stuck/hallucinates, force pass to avoid infinite loop
            client.events.endTurn();
        }
        
        state = client.getState();
        moveCount++;
    }

    if (!state.ctx.gameover) {
        // Match timed out (Bots were too cowardly). Return heavy penalty scores.
        return { team0: { total: -5000 }, team1: { total: -5000 } };
    }

    return state.ctx.gameover.scores;
}

// 4. THE EVOLUTIONARY LOOP
async function train() {
    const POPULATION_SIZE = 20;
    const GENERATIONS = 50;
    const MATCHES_PER_GENERATION = 10; // To average out luck of the draw

    console.log("🧬 Initializing Bot Population...");
    let population = Array(POPULATION_SIZE).fill(null).map(() => mutate(BASE_GENOME, 0.5)); // Start with heavy mutation

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

        // Print the DNA of the current champion so you can copy-paste it into the game if it's good!
        if (gen % 10 === 0 || gen === GENERATIONS) {
            console.log(`\n👑 Champion DNA (Gen ${gen}):`);
            console.log(JSON.stringify(rankedBots[0].genome, null, 2));
        }
    }
}

train();
