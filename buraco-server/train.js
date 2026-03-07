import { BuracoGame } from './game.js';
import fs from 'fs';
import path from 'path';

const DNA_SIZE = 49668;
const BOTS_DIR = path.join(process.cwd(), 'bots');
if (!fs.existsSync(BOTS_DIR)) fs.mkdirSync(BOTS_DIR, { recursive: true });

const activeTrainings = new Map();

function mutate(genome, mutationRate = 0.1, maxStep = 0.5) {
    const mutated = new Float32Array(genome);
    for (let i = 0; i < DNA_SIZE; i++)
        if (Math.random() < mutationRate)
            mutated[i] += (Math.random() * 2 - 1) * maxStep;
    return mutated;
}

function breed(parentA, parentB) {
    const child = new Float32Array(DNA_SIZE);
    for (let i = 0; i < DNA_SIZE; i++)
        child[i] = Math.random() > 0.5 ? parentA[i] : parentB[i];
    return mutate(child);
}

const generateRandomGenome = () => {
    const g = new Float32Array(DNA_SIZE);
    for (let i = 0; i < DNA_SIZE; i++) g[i] = (Math.random() - 0.5);
    return g;
};

function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function initState(rules, numPlayers, fixedDeck = null) {
    const fakeRandom = { Shuffle: (arr) => fixedDeck ? [...fixedDeck] : shuffle(arr) };
    return BuracoGame.setup({ random: fakeRandom, ctx: { numPlayers } }, rules);
}

function applyMove(G, ctx, moveName, args) {
    const result = BuracoGame.moves[moveName]({ G, ctx, events: { endTurn: () => { ctx._endTurn = true; } } }, ...args);
    return result !== 'INVALID_MOVE';
}

// Expose all hands as knownCards so bots can't develop discard-based signaling
function revealAllHands(G) {
    for (const p of Object.keys(G.hands))
        G.knownCards[p] = [...G.hands[p]];
}

// Run a single match. Returns { team0total, team1total, pointsDiff } from team0's perspective.
function runMatch(genomes, rules, fixedDeck = null) {
    const numPlayers = rules.numPlayers || 4;
    const G = initState(rules, numPlayers, fixedDeck);
    revealAllHands(G);

    const ctx = { currentPlayer: '0', numPlayers, turn: 1, gameover: undefined, _endTurn: false };

    try {
        let moveCount = 0;
        const MAX_MOVES = 800;
        let lastMoveKey = null;

        while (!ctx.gameover && moveCount < MAX_MOVES) {
            const p = ctx.currentPlayer;
            const moves = BuracoGame.ai.enumerate(G, ctx, genomes[p]);

            if (!moves || moves.length === 0) {
                ctx._endTurn = true;
            } else {
                const nextMove = moves[0];
                const moveKey = `${nextMove.move}:${(nextMove.args || []).flat().join(',')}`;
                if (moveKey === lastMoveKey) {
                    ctx._endTurn = true;
                } else {
                    lastMoveKey = moveKey;
                    ctx._endTurn = false;
                    applyMove(G, ctx, nextMove.move, nextMove.args || []);
                    // Re-reveal hands after every move (new drawn cards etc.)
                    revealAllHands(G);
                }
            }

            if (ctx._endTurn) {
                ctx.currentPlayer = String((parseInt(ctx.currentPlayer) + 1) % numPlayers);
                ctx.turn++;
                G.hasDrawn = false;
                G.lastDrawnCard = null;
                lastMoveKey = null;
                ctx._endTurn = false;
            }

            ctx.gameover = BuracoGame.endIf({ G, ctx });
            moveCount++;
        }

        const scores = ctx.gameover
            ? ctx.gameover.scores
            : { team0: { total: -5000 }, team1: { total: -5000 } };

        return {
            team0: scores.team0.total,
            team1: scores.team1.total,
            diff: scores.team0.total - scores.team1.total
        };
    } catch (e) {
        console.error('[TRAINER] runMatch crashed:', e.message);
        return { team0: -5000, team1: -5000, diff: 0 };
    }
}

// A "playoff match" = same deck played twice, swapping team positions.
// botA plays seats 0+2 in game1, seats 1+3 in game2.
// Score = sum of pointsDiff from botA's perspective across both games.
function playoffMatch(botA, botB, rules) {
    // Generate a fixed deck for both games
    const deckSize = rules.noJokers ? 104 : 108;
    const fixedDeck = shuffle(Array.from({ length: deckSize }, (_, i) => i));

    // Game 1: botA = team0 (seats 0,2), botB = team1 (seats 1,3)
    const g1 = runMatch({ '0': botA, '1': botB, '2': botA, '3': botB }, rules, fixedDeck);
    // Game 2: botA = team1 (seats 1,3), botB = team0 (seats 0,2)
    const g2 = runMatch({ '0': botB, '1': botA, '2': botB, '3': botA }, rules, fixedDeck);

    // botA's score: g1.diff (team0=botA) + (-g2.diff) (team1=botA in g2)
    return g1.diff + (-g2.diff);
}

// Single-elimination playoff tournament among all bots.
// Returns indices of the 4 finalists.
async function runPlayoffTournament(population, rules) {
    let remaining = population.map((genome, i) => ({ genome, id: i }));

    // Seed randomly
    shuffle(remaining);

    // Pad to next power of 2 if needed (byes go through automatically)
    while (remaining.length & (remaining.length - 1)) remaining.push(null);

    while (remaining.length > 4) {
        const nextRound = [];
        for (let i = 0; i < remaining.length; i += 2) {
            await new Promise(resolve => setImmediate(resolve));
            const a = remaining[i];
            const b = remaining[i + 1];
            if (!a) { nextRound.push(b); continue; }
            if (!b) { nextRound.push(a); continue; }
            const score = playoffMatch(a.genome, b.genome, rules);
            nextRound.push(score >= 0 ? a : b);
        }
        remaining = nextRound;
    }

    return remaining.filter(Boolean).map(r => r.genome);
}

export const TrainerService = {

    getBotWeights: (botName) => {
        const filePath = path.join(BOTS_DIR, `${botName}.json`);
        if (!fs.existsSync(filePath)) return null;
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    },

    getTrainingStatus: (botName) => {
        if (!activeTrainings.has(botName)) return { isTraining: false, progress: null };
        return { isTraining: true, progress: activeTrainings.get(botName) };
    },

    startTraining: async (botName, rules = {}, params = {}) => {
        if (activeTrainings.has(botName)) throw new Error(`Training already in progress for: ${botName}`);

        const POPULATION_SIZE = Math.max(8, params.populationSize || 24);
        const GENERATIONS = params.generations || 500;
        const SAVE_EVERY = params.saveInterval || params.matchesPerGeneration || 12;

        const seedDNA = TrainerService.getBotWeights(botName);
        const originalDNA = seedDNA ? new Float32Array(seedDNA) : null;

        let population;
        if (seedDNA) {
            console.log(`🧠 Resuming training for '${botName}'...`);
            let base = seedDNA;
            if (base.length !== DNA_SIZE) {
                let expanded = [];
                while (expanded.length < DNA_SIZE) expanded.push(...base);
                base = expanded.slice(0, DNA_SIZE);
            }
            const baseF32 = new Float32Array(base);
            population = Array(POPULATION_SIZE).fill(null).map((_, i) =>
                i === 0 ? baseF32 : mutate(baseF32, 0.2, 0.5)
            );
        } else {
            console.log(`🧠 Starting fresh training for '${botName}'...`);
            population = Array(POPULATION_SIZE).fill(null).map(() => generateRandomGenome());
        }

        activeTrainings.set(botName, {
            currentGeneration: 0, totalGenerations: GENERATIONS,
            maxDiff: 0, avgDiff: 0,
            maxPoints: 0, avgPoints: 0,
            benchmarkDiff: null
        });

        try {
            for (let gen = 1; gen <= GENERATIONS; gen++) {
                // --- PLAYOFF TOURNAMENT to find top 4 ---
                const finalists = await runPlayoffTournament(population, rules);

                // --- STATS: play each finalist vs the rest to get scores ---
                let allDiffs = [];
                for (const f of finalists) {
                    await new Promise(resolve => setImmediate(resolve));
                    for (const opp of finalists) {
                        if (f === opp) continue;
                        allDiffs.push(playoffMatch(f, opp, rules));
                    }
                }

                const bestDiff = Math.max(...allDiffs);
                const avgDiff = allDiffs.reduce((a, b) => a + b, 0) / allDiffs.length;

                // --- BUILD NEXT GENERATION ---
                // 4 clones, 4 mutations, rest are crossbreeds
                const clones = finalists.map(f => new Float32Array(f));
                const mutations = finalists.map(f => mutate(f, 0.1, 0.3));
                const crossbreeds = [];
                while (crossbreeds.length < POPULATION_SIZE - 8) {
                    const a = finalists[Math.floor(Math.random() * finalists.length)];
                    const b = finalists[Math.floor(Math.random() * finalists.length)];
                    crossbreeds.push(breed(a, b));
                }
                population = [...clones, ...mutations, ...crossbreeds];

                const prevProgress = activeTrainings.get(botName);
                const progress = {
                    currentGeneration: gen, totalGenerations: GENERATIONS,
                    maxDiff: bestDiff,
                    avgDiff,
                    maxPoints: Math.max(...allDiffs.map(d => d + 5000)), // approximate absolute score
                    avgPoints: avgDiff + 5000,
                    benchmarkDiff: prevProgress?.benchmarkDiff ?? null
                };

                // --- SAVE & BENCHMARK vs original ---
                if (gen % SAVE_EVERY === 0 || gen === GENERATIONS) {
                    const bestGenome = finalists[0];
                    const filePath = path.join(BOTS_DIR, `${botName}.json`);
                    fs.writeFileSync(filePath, JSON.stringify(Array.from(bestGenome)));

                    if (originalDNA) {
                        progress.benchmarkDiff = playoffMatch(bestGenome, originalDNA, rules);
                    }
                }

                activeTrainings.set(botName, progress);
                console.log(`[${botName}] Gen ${gen}/${GENERATIONS} | MaxDiff: ${bestDiff.toFixed(0)} | AvgDiff: ${avgDiff.toFixed(0)} | Bench: ${progress.benchmarkDiff ?? 'N/A'}`);

                await new Promise(resolve => setImmediate(resolve));
            }
        } catch (error) {
            console.error(`[TRAINER] Error for ${botName}:`, error);
        } finally {
            console.log(`✅ Training complete for '${botName}'!`);
            activeTrainings.delete(botName);
        }
    }
};
