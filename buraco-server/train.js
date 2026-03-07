import { BuracoGame } from './game.js';
import fs from 'fs';
import path from 'path';
import { Worker } from 'worker_threads';
import { cpus } from 'os';

const NUM_WORKERS = Math.max(1, cpus().length - 1); // leave 1 core for the server
const WORKER_PATH = new URL('./worker.js', import.meta.url).pathname;

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

// Transfer genome to a transferable ArrayBuffer for zero-copy worker dispatch
function toBuffer(genome) {
    const buf = new SharedArrayBuffer(DNA_SIZE * 4);
    new Float32Array(buf).set(genome);
    return buf;
}

// Run a batch of playoff matches across worker threads in parallel
function runMatchBatch(matchPairs, rules) {
    return new Promise((resolve, reject) => {
        // Split pairs across workers
        const chunkSize = Math.ceil(matchPairs.length / NUM_WORKERS);
        const chunks = [];
        for (let i = 0; i < matchPairs.length; i += chunkSize)
            chunks.push(matchPairs.slice(i, i + chunkSize));

        const allResults = new Array(matchPairs.length);
        let completed = 0;
        let offset = 0;

        chunks.forEach((chunk, ci) => {
            const chunkOffset = ci * chunkSize;
            const worker = new Worker(WORKER_PATH, {
                workerData: { matches: chunk, rules }
            });
            worker.on('message', (results) => {
                results.forEach((r, i) => allResults[chunkOffset + i] = r);
                completed++;
                if (completed === chunks.length) resolve(allResults);
            });
            worker.on('error', reject);
        });
    });
}

// Single-elimination playoff tournament, all rounds dispatched in parallel batches
async function runPlayoffTournament(population, rules) {
    let remaining = population.map((genome, i) => ({ genome, id: i, buf: toBuffer(genome) }));
    shuffle(remaining);
    while (remaining.length & (remaining.length - 1)) remaining.push(null);

    while (remaining.length > 4) {
        // Build all match pairs for this round
        const pairs = [];
        const pairIndices = [];
        for (let i = 0; i < remaining.length; i += 2) {
            const a = remaining[i], b = remaining[i + 1];
            if (!a || !b) { pairIndices.push({ a, b, bye: true }); continue; }
            pairs.push({ dnaA: a.buf, dnaB: b.buf });
            pairIndices.push({ a, b, bye: false });
        }

        // Run all non-bye matches in parallel across workers
        const scores = pairs.length > 0 ? await runMatchBatch(pairs, rules) : [];
        let scoreIdx = 0;
        remaining = pairIndices.map(({ a, b, bye }) => {
            if (bye) return a || b;
            const [sA] = scores[scoreIdx++]; // use scoreA to determine winner
            return sA >= 0 ? a : b;
        });
    }

    return remaining.filter(Boolean).map(r => r.genome);
}

export const TrainerService = {

    getBotWeights: (botName) => {
        const filePath = path.join(BOTS_DIR, `${botName}.json`);
        if (!fs.existsSync(filePath)) return null;
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        // Handle both plain arrays and object-serialized Float32Arrays
        return Array.isArray(raw) ? raw : Object.values(raw);
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

        const NUM_ISLANDS = 4;
        const MIGRATE_EVERY = 5;
        const islandPops = Array.from({ length: NUM_ISLANDS }, () =>
            population.slice(0, POPULATION_SIZE).map(g => new Float32Array(g))
        );

        // Run one generation for a single island, returns { rankedFinalists, bestDiff, avgDiff }
        const runIslandGeneration = async (pop) => {
            const finalists = await runPlayoffTournament(pop, rules);
            const statPairs = [], statMeta = [];
            for (let i = 0; i < finalists.length; i++)
                for (let j = i + 1; j < finalists.length; j++) {
                    statPairs.push({ dnaA: toBuffer(finalists[i]), dnaB: toBuffer(finalists[j]) });
                    statMeta.push([i, j]);
                }
            const allDiffs = [];
            const finalistScores = new Array(finalists.length).fill(0);
            if (statPairs.length > 0) {
                const results = await runMatchBatch(statPairs, rules);
                results.forEach(([sA], idx) => {
                    const [i, j] = statMeta[idx];
                    allDiffs.push(Math.abs(sA));
                    if (sA > 0) finalistScores[i]++; else finalistScores[j]++;
                });
            } else { allDiffs.push(0); }
            const rankedFinalists = finalists
                .map((f, i) => ({ genome: f, score: finalistScores[i] }))
                .sort((a, b) => b.score - a.score)
                .map(x => x.genome);
            const clones = rankedFinalists.slice(0, 2).map(f => new Float32Array(f));
            const mutations = rankedFinalists.map(f => mutate(f, 0.1, 0.3));
            const crossbreeds = [];
            while (crossbreeds.length < pop.length - clones.length - mutations.length) {
                const pick = () => rankedFinalists[Math.floor(Math.random() * Math.random() * rankedFinalists.length)];
                crossbreeds.push(breed(pick(), pick()));
            }
            return {
                nextPop: [...clones, ...mutations, ...crossbreeds],
                rankedFinalists,
                bestDiff: Math.max(...allDiffs),
                avgDiff: allDiffs.reduce((a, b) => a + b, 0) / allDiffs.length
            };
        };

        try {
            for (let gen = 1; gen <= GENERATIONS; gen++) {
                // Run all islands in parallel
                const islandResults = await Promise.all(islandPops.map(pop => runIslandGeneration(pop)));

                // Update island populations
                islandResults.forEach((r, k) => { islandPops[k] = r.nextPop; });

                // Migration: every MIGRATE_EVERY gens, best of each island replaces a random non-elite in every other island
                if (gen % MIGRATE_EVERY === 0) {
                    const elites = islandResults.map(r => r.rankedFinalists[0]);
                    for (let k = 0; k < NUM_ISLANDS; k++) {
                        for (let src = 0; src < NUM_ISLANDS; src++) {
                            if (src === k) continue;
                            // Replace a random member beyond the top 2 clones
                            const replaceIdx = 2 + Math.floor(Math.random() * (islandPops[k].length - 2));
                            islandPops[k][replaceIdx] = new Float32Array(elites[src]);
                        }
                    }
                }

                // Aggregate stats across islands
                const bestDiff = Math.max(...islandResults.map(r => r.bestDiff));
                const avgDiff = islandResults.reduce((s, r) => s + r.avgDiff, 0) / NUM_ISLANDS;
                const bestIsland = islandResults.reduce((best, r, k) => r.bestDiff > best.diff ? { k, diff: r.bestDiff, r } : best, { k: 0, diff: -Infinity, r: islandResults[0] });
                const bestGenome = bestIsland.r.rankedFinalists[0];

                const prevProgress = activeTrainings.get(botName);
                const progress = {
                    currentGeneration: gen, totalGenerations: GENERATIONS,
                    maxDiff: bestDiff, avgDiff,
                    maxPoints: bestDiff + 5000, avgPoints: avgDiff + 5000,
                    benchmarkDiff: prevProgress?.benchmarkDiff ?? null
                };

                if (gen % SAVE_EVERY === 0 || gen === GENERATIONS) {
                    const filePath = path.join(BOTS_DIR, `${botName}.json`);
                    fs.writeFileSync(filePath, JSON.stringify(Array.from(bestGenome)));
                    if (originalDNA) {
                        const [[benchScore]] = await runMatchBatch(
                            [{ dnaA: toBuffer(bestGenome), dnaB: toBuffer(originalDNA) }], rules
                        );
                        progress.benchmarkDiff = benchScore;
                    }
                }

                activeTrainings.set(botName, progress);
                console.log(`[${botName}] Gen ${gen}/${GENERATIONS} | MaxDiff: ${bestDiff.toFixed(0)} | AvgDiff: ${avgDiff.toFixed(0)} | Bench: ${progress.benchmarkDiff ?? 'N/A'}`);
            }
        } catch (error) {
            console.error(`[TRAINER] Error for ${botName}:`, error);
        } finally {
            console.log(`✅ Training complete for '${botName}'!`);
            activeTrainings.delete(botName);
        }
    }
};
