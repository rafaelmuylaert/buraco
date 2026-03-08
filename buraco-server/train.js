import { BuracoGame } from './game.js';
import fs from 'fs';
import path from 'path';
import { Worker } from 'worker_threads';
import { cpus } from 'os';

const NUM_WORKERS = Math.max(1, cpus().length - 1); // leave 1 core for the server
const WORKER_PATH = new URL('./worker.js', import.meta.url).pathname;

const DNA_SIZE = 37251;
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

// Persistent worker pool — workers stay alive for the duration of training
class WorkerPool {
    constructor(size, path) {
        this.queue = [];
        this.workers = Array.from({ length: size }, () => {
            const w = new Worker(path, { workerData: { matches: [], rules: {} } });
            w.idle = true;
            w.on('message', (results) => {
                const { resolve, size: batchSize, offset, allResults, remaining, onDone } = w.currentJob;
                results.forEach((r, i) => allResults[offset + i] = r);
                remaining.count--;
                w.idle = true;
                w.currentJob = null;
                if (remaining.count === 0) onDone(allResults);
                else this._dispatch();
            });
            return w;
        });
    }

    run(matchPairs, rules) {
        return new Promise((resolve) => {
            const allResults = new Array(matchPairs.length);
            const chunkSize = Math.max(1, Math.ceil(matchPairs.length / this.workers.length));
            const chunks = [];
            for (let i = 0; i < matchPairs.length; i += chunkSize)
                chunks.push({ chunk: matchPairs.slice(i, i + chunkSize), offset: i });
            const remaining = { count: chunks.length };
            const onDone = resolve;
            for (const { chunk, offset } of chunks)
                this.queue.push({ matches: chunk, rules, offset, allResults, remaining, onDone });
            this._dispatch();
        });
    }

    _dispatch() {
        for (const w of this.workers) {
            if (!w.idle || this.queue.length === 0) continue;
            const job = this.queue.shift();
            w.idle = false;
            w.currentJob = { ...job, size: job.matches.length };
            w.postMessage({ matches: job.matches, rules: job.rules });
        }
    }

    broadcastDeck(deck) {
        for (const w of this.workers) w.postMessage({ type: 'shuffleDeck', deck });
    }

    terminate() { this.workers.forEach(w => w.terminate()); }
}

let _pool = null;
function getPool() {
    if (!_pool) _pool = new WorkerPool(NUM_WORKERS, WORKER_PATH);
    return _pool;
}

function runMatchBatch(matchPairs, rules) {
    return getPool().run(matchPairs, rules);
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
        const arr = Array.isArray(raw) ? raw : Object.values(raw);
        return arr.length > DNA_SIZE ? arr.slice(0, DNA_SIZE) : arr;
    },

    getTrainingStatus: (botName) => {
        if (!activeTrainings.has(botName)) return { isTraining: false, progress: null };
        return { isTraining: true, progress: activeTrainings.get(botName) };
    },

    getAllTrainingStatuses: () => {
        const result = [];
        for (const [botName, progress] of activeTrainings.entries())
            result.push({ botName, isTraining: true, progress });
        return result;
    },

    startTraining: async (botName, rules = {}, params = {}) => {
        if (activeTrainings.has(botName)) throw new Error(`Training already in progress for: ${botName}`);

        const POPULATION_SIZE = Math.max(8, params.populationSize || 24);
        const GENERATIONS = params.generations || 500;
        const SAVE_EVERY = params.saveInterval || params.matchesPerGeneration || 12;

        const seedDNA = TrainerService.getBotWeights(botName);
        const originalDNA = generateRandomGenome(); // benchmark always against a fresh random baseline

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
            benchmarkDiff: null,
            islands: []
        });

        const NUM_ISLANDS = Math.max(2, cpus().length - 1);

        // Deck built once; shuffled each generation unless fixedDeck
        const baseDeck = [];
        for (let i = 0; i < 52; i++) baseDeck.push(i);
        for (let i = 0; i < 52; i++) baseDeck.push(i);
        if (!rules.noJokers) baseDeck.push(54, 54);

        const islandPops = Array.from({ length: NUM_ISLANDS }, () =>
            population.slice(0, POPULATION_SIZE).map(g => new Float32Array(g))
        );
        // Shared champions: each island deposits its best here; others read on next gen
        const islandElites = new Array(NUM_ISLANDS).fill(null);

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

        // Shuffle deck once before training starts; workers receive it
        if (!rules.fixedDeck) shuffle(baseDeck);
        getPool().broadcastDeck(baseDeck);

        let completedIslands = 0;
        const islandErrors = [];

        const runIsland = async (islandIdx) => {
            try {
                for (let gen = 1; gen <= GENERATIONS; gen++) {
                    // Shuffle deck each generation (all islands share the same shuffle signal)
                    if (!rules.fixedDeck && islandIdx === 0) {
                        shuffle(baseDeck);
                        getPool().broadcastDeck(baseDeck);
                    }

                    const result = await runIslandGeneration(islandPops[islandIdx]);
                    islandPops[islandIdx] = result.nextPop;

                    // Inject any available elites from other islands
                    for (let src = 0; src < NUM_ISLANDS; src++) {
                        if (src === islandIdx || !islandElites[src]) continue;
                        const replaceIdx = 2 + Math.floor(Math.random() * (islandPops[islandIdx].length - 2));
                        islandPops[islandIdx][replaceIdx] = new Float32Array(islandElites[src]);
                    }

                    // Broadcast champion + update stats every SAVE_EVERY gens
                    if (gen % SAVE_EVERY === 0 || gen === GENERATIONS) {
                        islandElites[islandIdx] = result.rankedFinalists[0];

                        // Each island saves to its own file — no race condition
                        fs.writeFileSync(
                            path.join(BOTS_DIR, `${botName}_${islandIdx}.json`),
                            JSON.stringify(Array.from(result.rankedFinalists[0]))
                        );

                        const prevProgress = activeTrainings.get(botName);
                        const islands = [...(prevProgress?.islands || [])];
                        islands[islandIdx] = { gen, bestDiff: result.bestDiff, avgDiff: result.avgDiff };
                        activeTrainings.set(botName, {
                            ...prevProgress,
                            currentGeneration: Math.max(...islands.map(x => x?.gen || 0)),
                            totalGenerations: GENERATIONS,
                            islands
                        });
                        console.log(`[${botName}] Island ${islandIdx} Gen ${gen}/${GENERATIONS} | MaxDiff: ${result.bestDiff.toFixed(0)} | AvgDiff: ${result.avgDiff.toFixed(0)}`);
                    }
                }
            } catch (err) {
                islandErrors.push(err);
                console.error(`[TRAINER] Island ${islandIdx} error:`, err);
            } finally {
                completedIslands++;
            }
        };

        try {
            await Promise.all([
                // Island evolution loops
                ...Array.from({ length: NUM_ISLANDS }, (_, k) => runIsland(k)),
                // Championship loop: runs independently, crowns best island bot
                (async () => {
                    while (completedIslands < NUM_ISLANDS) {
                        await new Promise(r => setTimeout(r, SAVE_EVERY * 800)); // rough cadence
                        const candidates = [];
                        for (let k = 0; k < NUM_ISLANDS; k++) {
                            const fp = path.join(BOTS_DIR, `${botName}_${k}.json`);
                            if (!fs.existsSync(fp)) continue;
                            const raw = JSON.parse(fs.readFileSync(fp, 'utf-8'));
                            candidates.push({ k, genome: new Float32Array(Array.isArray(raw) ? raw : Object.values(raw)) });
                        }
                        if (candidates.length < 2) continue;

                        // Round-robin among available island champions
                        const wins = new Array(candidates.length).fill(0);
                        const pairs = [];
                        for (let i = 0; i < candidates.length; i++)
                            for (let j = i + 1; j < candidates.length; j++)
                                pairs.push({ i, j, dnaA: toBuffer(candidates[i].genome), dnaB: toBuffer(candidates[j].genome) });

                        const results = await runMatchBatch(pairs.map(p => ({ dnaA: p.dnaA, dnaB: p.dnaB })), rules);
                        results.forEach(([sA], idx) => {
                            if (sA > 0) wins[pairs[idx].i]++; else wins[pairs[idx].j]++;
                        });

                        const bestIdx = wins.indexOf(Math.max(...wins));
                        const champion = candidates[bestIdx].genome;
                        fs.writeFileSync(path.join(BOTS_DIR, `${botName}.json`), JSON.stringify(Array.from(champion)));
                        fs.writeFileSync(path.join(BOTS_DIR, `${botName}.meta.json`), JSON.stringify({ rules, trainParams: { populationSize: POPULATION_SIZE, generations: GENERATIONS, saveInterval: SAVE_EVERY, telepathy: params.telepathy, fixedDeck: params.fixedDeck } }));

                        let benchmarkDiff = null;
                        if (originalDNA) {
                            try {
                                // Shuffle a fresh deck and broadcast it so both swapped games use identical cards
                                const benchDeck = rules.noJokers ? [...baseDeck] : [...baseDeck, 54, 54];
                                shuffle(benchDeck);
                                getPool().broadcastDeck(benchDeck);
                                const [[benchScore]] = await runMatchBatch(
                                    [{ dnaA: toBuffer(champion), dnaB: toBuffer(originalDNA) }],
                                    { ...rules, fixedDeck: true }
                                );
                                benchmarkDiff = benchScore;
                            } catch (e) {
                                console.error(`[${botName}] Benchmark error:`, e);
                            }
                        }

                        const prev = activeTrainings.get(botName);
                        if (prev) activeTrainings.set(botName, { ...prev, benchmarkDiff });
                        console.log(`[${botName}] 🏆 Champion: Island ${candidates[bestIdx].k} | Bench: ${benchmarkDiff ?? 'N/A'}`);
                    }
                })()
            ]);
            if (islandErrors.length) console.error(`[TRAINER] ${islandErrors.length} island(s) failed for ${botName}`);
        } catch (error) {
            console.error(`[TRAINER] Error for ${botName}:`, error);
        } finally {
            console.log(`✅ Training complete for '${botName}'!`);
            if (_pool) { _pool.terminate(); _pool = null; }
            activeTrainings.delete(botName);
        }
    }
};
