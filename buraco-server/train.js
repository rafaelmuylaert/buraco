import fs from 'fs';
import path from 'path';
import { Worker } from 'worker_threads';
import { cpus } from 'os';
import { AI_CONFIG } from './game.js';

const NUM_WORKERS = Math.max(1, cpus().length - 1); 
const WORKER_PATH = new URL('./worker.js', import.meta.url).pathname; 

const BOTS_DIR = path.join(process.cwd(), 'bots');
if (!fs.existsSync(BOTS_DIR)) fs.mkdirSync(BOTS_DIR, { recursive: true });

const activeTrainings = new Map();
const stopFlags = new Set();

function gaussianRandom() {
    // Box-Muller transform
    let u, v;
    do { u = Math.random(); } while (u === 0);
    do { v = Math.random(); } while (v === 0);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function mutate(genome, mutationRate = 0.05, mutationStrength = 0.1) {
    const mutated = new Float32Array(genome);
    for (let i = 0; i < mutated.length; i++) {
        if (Math.random() < mutationRate) {
            mutated[i] += gaussianRandom() * mutationStrength;
        }
    }
    return mutated;
}

function breed(parentA, parentB) {
    const child = new Float32Array(parentA.length);
    for (let i = 0; i < child.length; i++) {
        // Uniform blend crossover with small mutation
        const alpha = Math.random();
        child[i] = alpha * parentA[i] + (1 - alpha) * parentB[i];
    }
    return mutate(child, 0.05, 0.05);
}

const generateRandomGenome = () => {
    const g = new Float32Array(AI_CONFIG.TOTAL_DNA_SIZE);
    // Xavier init per network segment using each net's input size
    let off = 0;
    for (const key of ['PICKUP', 'MELD', 'DISCARD']) {
        const inSize = AI_CONFIG[key + '_INPUT_SIZE'];
        const scale = 1 / Math.sqrt(inSize);
        const end = off + AI_CONFIG['DNA_' + key];
        for (let i = off; i < end; i++) g[i] = gaussianRandom() * scale;
        off = end;
    }
    return g;
};

function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function toBuffer(genome) {
    const buf = new SharedArrayBuffer(AI_CONFIG.TOTAL_DNA_SIZE * 4);
    new Float32Array(buf).set(genome);
    return buf;
}

class WorkerPool {
    constructor(size, path) {
        this.queue = [];
        this._timings = { buildStateVector: 0, buildDiscardVector: 0, forwardPass: 0, getAllValidMelds: 0, getAllValidAppends: 0, _evalCount: 0, _copyMs: 0 };
        this.workers = Array.from({ length: size }, () => {
            const w = new Worker(path, { workerData: { matches: [], rules: {} } });
            w.idle = true;
            w.on('message', (msg) => {
                if (!w.currentJob) return; // shuffleDeck ack or stray message
                const results = msg?.results ?? msg;
                if (msg?.timings) {
                    for (const k of Object.keys(this._timings))
                        this._timings[k] += msg.timings[k] ?? 0;
                }
                const { offset, allResults, remaining, onDone } = w.currentJob;
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

    getAndResetTimings() {
        const snap = { ...this._timings };
        for (const k of Object.keys(this._timings)) this._timings[k] = 0;
        return snap;
    }

    run(matchPairs, rules) {
        if (matchPairs.length === 0) return Promise.resolve([]);
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

async function runPlayoffTournament(population, rules) {
    let remaining = population.map((genome, i) => ({ genome, id: i }));
    shuffle(remaining);
    while (remaining.length & (remaining.length - 1)) remaining.push(null);

    while (remaining.length > 4) {
        const pairs = [];
        const pairIndices = [];
        for (let i = 0; i < remaining.length; i += 2) {
            const a = remaining[i], b = remaining[i + 1];
            if (!a || !b) { pairIndices.push({ a, b, bye: true }); continue; }
            pairs.push({ dnaA: toBuffer(a.genome), dnaB: toBuffer(b.genome) });
            pairIndices.push({ a, b, bye: false });
        }

        const scores = pairs.length > 0 ? await runMatchBatch(pairs, rules) : [];
        let scoreIdx = 0;
        remaining = pairIndices.map(({ a, b, bye }) => {
            if (bye) return a || b;
            const [sA] = scores[scoreIdx++];
            return sA >= 0 ? a : b;
        });
    }

    return remaining.filter(Boolean).map(r => r.genome);
}

export const TrainerService = {

    stopTraining: (botName) => {
        if (!activeTrainings.has(botName)) return false;
        stopFlags.add(botName);
        return true;
    },

    getBotWeights: (botName) => {
        const filePath = path.join(BOTS_DIR, `${botName}.json`);
        if (!fs.existsSync(filePath)) return null;
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        const arr = Array.isArray(raw) ? raw : Object.values(raw);
        return arr.length > AI_CONFIG.TOTAL_DNA_SIZE ? arr.slice(0, AI_CONFIG.TOTAL_DNA_SIZE) : arr;
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
        if (params.greedyMode     != null) rules = { ...rules, greedyMode:          params.greedyMode };
        if (params.scoreCardPoints != null) rules = { ...rules, scoreCardPoints:     params.scoreCardPoints };
        if (params.scoreHandPenalty!= null) rules = { ...rules, scoreHandPenalty:    params.scoreHandPenalty };
        if (params.dirtyCanastraBonus!=null)rules = { ...rules, dirtyCanastraBonus:  params.dirtyCanastraBonus };
        if (params.cleanCanastraBonus!=null)rules = { ...rules, cleanCanastraBonus:  params.cleanCanastraBonus };
        if (params.mortoPenalty    != null) rules = { ...rules, mortoPenalty:        params.mortoPenalty };
        if (params.endGameBonus    != null) rules = { ...rules, endGameBonus:        params.endGameBonus };
        if (params.cardPointValues != null) rules = { ...rules, cardPointValues:     params.cardPointValues };
        if (params.meldSizeBonus   != null) rules = { ...rules, meldSizeBonus:       params.meldSizeBonus };

        const seedDNA = TrainerService.getBotWeights(botName);
        const originalDNA = generateRandomGenome();

        // Load lifetime generation count from meta
        const metaPath = path.join(BOTS_DIR, `${botName}.meta.json`);
        const existingMeta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf-8')) : null;
        const lifetimeGenOffset = existingMeta?.lifetimeGenerations || 0;

        let population;
        if (seedDNA) {
            console.log(`🧠 Resuming training for '${botName}'...`);
        } else {
            console.log(`🧠 Starting fresh training for '${botName}'...`);
        }

        // Helper to load a saved island genome, falling back to seedDNA or random
        const loadIslandSeed = (k) => {
            const fp = path.join(BOTS_DIR, `${botName}_${k}.json`);
            if (fs.existsSync(fp)) {
                const raw = JSON.parse(fs.readFileSync(fp, 'utf-8'));
                const arr = Array.isArray(raw) ? raw : Object.values(raw);
                return new Float32Array(arr.length === AI_CONFIG.TOTAL_DNA_SIZE ? arr : arr.slice(0, AI_CONFIG.TOTAL_DNA_SIZE));
            }
            if (seedDNA) {
                const arr = Array.isArray(seedDNA) ? seedDNA : Array.from(seedDNA);
                return new Float32Array(arr.length === AI_CONFIG.TOTAL_DNA_SIZE ? arr : arr.slice(0, AI_CONFIG.TOTAL_DNA_SIZE));
            }
            return generateRandomGenome();
        };

        activeTrainings.set(botName, {
            currentGeneration: 0, totalGenerations: GENERATIONS,
            lifetimeGenOffset,
            benchmarkDiff: null,
            islands: []
        });

        const NUM_ISLANDS = Math.max(2, cpus().length - 1);

        const baseDeck = [];
        for (let i = 0; i < 52; i++) baseDeck.push(i);
        for (let i = 0; i < 52; i++) baseDeck.push(i);
        if (!rules.noJokers) baseDeck.push(54, 54);

        const islandPops = Array.from({ length: NUM_ISLANDS }, (_, k) => {
            const seed = loadIslandSeed(k);
            return Array.from({ length: POPULATION_SIZE }, (_, i) =>
                i === 0 ? new Float32Array(seed) : mutate(seed, 0.05, 0.1)
            );
        });

        // Shared state for island coordination
        const islandElites = new Array(NUM_ISLANDS).fill(null);
        const islandBroadcastGen = new Array(NUM_ISLANDS).fill(0);
        const islandLastInjectedGen = new Array(NUM_ISLANDS).fill(0);
        let latestChampion = null;
        let championTournamentRunning = false;
        let lastChampionTournamentGen = 0; // milestone gen at which last tournament ran

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
                results.forEach(([sA, , rawA, rawB], idx) => {
                    const [i, j] = statMeta[idx];
                    allDiffs.push(rawA, rawB);
                    finalistScores[i] += sA;
                    finalistScores[j] -= sA;
                });
            } else { allDiffs.push(0); }
            const rankedFinalists = finalists
                .map((f, i) => ({ genome: f, score: finalistScores[i] }))
                .sort((a, b) => b.score - a.score)
                .map(x => x.genome);

            const clones = rankedFinalists.slice(0, 2).map(f => new Float32Array(f));
            const mutations = rankedFinalists.slice(1).map(f => mutate(f, 0.05, 0.1));
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

        // Run inter-island champion tournament and broadcast winner back to all islands.
        // Called by whichever island triggers the condition; guarded by championTournamentRunning.
        const runChampionTournament = async () => {
            if (championTournamentRunning) return;
            championTournamentRunning = true;
            try {
                const candidates = islandElites
                    .map((genome, k) => genome ? { k, genome } : null)
                    .filter(Boolean);
                if (candidates.length < 2) return;

                const wins = new Array(candidates.length).fill(0);
                const pairs = [];
                for (let i = 0; i < candidates.length; i++)
                    for (let j = i + 1; j < candidates.length; j++)
                        pairs.push({ i, j, dnaA: toBuffer(candidates[i].genome), dnaB: toBuffer(candidates[j].genome) });

                const results = await runMatchBatch(pairs.map(p => ({ dnaA: p.dnaA, dnaB: p.dnaB })), rules);
                results.forEach(([sA], idx) => {
                    wins[pairs[idx].i] += sA;
                    wins[pairs[idx].j] -= sA;
                });

                const bestIdx = wins.indexOf(Math.max(...wins));
                latestChampion = new Float32Array(candidates[bestIdx].genome);

                fs.writeFileSync(path.join(BOTS_DIR, `${botName}.json`), JSON.stringify(Array.from(latestChampion)));
                const currentLifetimeGen = lifetimeGenOffset + (activeTrainings.get(botName)?.currentGeneration || 0);
                fs.writeFileSync(path.join(BOTS_DIR, `${botName}.meta.json`), JSON.stringify({ rules, lifetimeGenerations: currentLifetimeGen, trainParams: { populationSize: POPULATION_SIZE, generations: GENERATIONS, saveInterval: SAVE_EVERY, telepathy: params.telepathy, fixedDeck: params.fixedDeck, scoreCardPoints: params.scoreCardPoints, scoreHandPenalty: params.scoreHandPenalty, dirtyCanastraBonus: params.dirtyCanastraBonus, cleanCanastraBonus: params.cleanCanastraBonus, mortoPenalty: params.mortoPenalty, endGameBonus: params.endGameBonus, cardPointValues: params.cardPointValues, meldSizeBonus: params.meldSizeBonus } }));

                let benchmarkDiff = null;
                if (originalDNA) {
                    try {
                        const benchDeck = [...baseDeck];
                        shuffle(benchDeck);
                        getPool().broadcastDeck(benchDeck);
                        const [[benchScore]] = await runMatchBatch(
                            [{ dnaA: toBuffer(latestChampion), dnaB: toBuffer(originalDNA) }],
                            { ...rules, fixedDeck: true }
                        );
                        benchmarkDiff = benchScore;
                    } catch (e) {}
                }
                const prev = activeTrainings.get(botName);
                if (prev) activeTrainings.set(botName, { ...prev, benchmarkDiff });
                console.log(`[${botName}] 🏆 Champion: Island ${candidates[bestIdx].k} | Bench: ${benchmarkDiff ?? 'N/A'}`);
            } finally {
                championTournamentRunning = false;
            }
        };

        let completedIslands = 0;
        const islandErrors = [];

        const runIsland = async (islandIdx) => {
            try {
                for (let gen = 1; gen <= GENERATIONS; gen++) {
                    if (stopFlags.has(botName)) break;
                    const result = await runIslandGeneration(islandPops[islandIdx]);
                    islandPops[islandIdx] = result.nextPop;

                    if (gen % SAVE_EVERY === 0 || gen === GENERATIONS) {
                        // Inject latest champion once per broadcast cycle
                        if (latestChampion && gen - islandLastInjectedGen[islandIdx] >= SAVE_EVERY) {
                            const replaceIdx = 2 + Math.floor(Math.random() * (islandPops[islandIdx].length - 2));
                            islandPops[islandIdx][replaceIdx] = new Float32Array(latestChampion);
                            islandLastInjectedGen[islandIdx] = gen;
                        }

                        // Broadcast this island's champion
                        islandElites[islandIdx] = result.rankedFinalists[0];
                        islandBroadcastGen[islandIdx] = gen;

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
                        const t = getPool().getAndResetTimings();
                        console.log(`[${botName}] [TIMING/${SAVE_EVERY}gens] forwardPass=${t.forwardPass.toFixed(0)}ms copyToWasm=${(t._copyMs||0).toFixed(0)}ms evalCount=${(t._evalCount||0).toFixed(0)} getAllValidMelds=${t.getAllValidMelds.toFixed(0)}ms getAllValidAppends=${(t.getAllValidAppends||0).toFixed(0)}ms`);

                        // Fire champion tournament only when ALL islands have completed
                        // this milestone round — i.e. every island's broadcastGen is a
                        // multiple of SAVE_EVERY strictly greater than the last tournament.
                        const minBroadcastGen = Math.min(...islandBroadcastGen);
                        const roundGen = Math.floor(minBroadcastGen / SAVE_EVERY) * SAVE_EVERY;
                        if (roundGen > lastChampionTournamentGen && islandElites.every(e => e !== null)) {
                            lastChampionTournamentGen = roundGen;
                            runChampionTournament(); // fire-and-forget, guarded internally
                        }
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
            await Promise.allSettled(Array.from({ length: NUM_ISLANDS }, (_, k) => runIsland(k)));
            // Final champion tournament after all islands finish
            if (islandElites.some(e => e !== null)) await runChampionTournament();
            if (islandErrors.length) console.error(`[TRAINER] ${islandErrors.length} island(s) failed for ${botName}`);
        } catch (error) {
            console.error(`[TRAINER] Error for ${botName}:`, error);
        } finally {
            console.log(`✅ Training complete for '${botName}'!`);
            if (_pool) { _pool.terminate(); _pool = null; }
            activeTrainings.delete(botName);
            stopFlags.delete(botName);
        }
    }
};
