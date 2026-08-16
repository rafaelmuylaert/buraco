// ─── Overview ──────────────────────────────────────────────────────────────────
// train.js — AI Genetic Training Pipeline
//
// This module implements the entire genetic algorithm for training Buraco AI bots.
// It manages a pool of Worker Threads (one per CPU), runs island-based evolution,
// and orchestrates champion tournaments to select the best bot.
//
// Main functions/services:
//   TrainerService.startTraining(botName, rules, params)  — Starts a full training run
//   TrainerService.stopTraining(botName)                  — Signals a training run to stop
//   TrainerService.getBotWeights(botName)                 — Loads saved weights from disk
//   TrainerService.getTrainingStatus(botName)             — Returns progress info
//   runDebugMatch(dna, rules)                             — Runs a single debug match
//   runMatchBatch(matchPairs, rules)                      — Dispatches matches to worker pool
//   runIslandGeneration(population, weightClip)           — Two-stage round-robin island generation
//   runBattleRoyale(roundGen)                             — Champion arena: RR of all island champions
//   breedNodeLevel(parentA, parentB, scoreA, scoreB)      — Node-level crossover with weighted selection
//   mutate(genome, rate, strength)                        — Gaussian random perturbation
//   generateRandomGenome()                                — Xavier-initialized random weights
//
// Key architecture:
//   - WorkerPool: Manages N worker threads (cpus()-1), dispatches match batches in chunks
//   - Island evolution: Islands 1..N-1 evolve independently (two-stage round-robin per generation)
//   - Champion arena (island 0): Idle between milestones; at each milestone it runs a battle royale
//     of the champions published by all normal islands plus its own kept elite, under several deck
//     shuffles. The winner is promoted to the official bot (monotonic: the saved champion is inside
//     the round-robin). Island 0 runs the final battle royale when all islands finish.
//   - Broadcast migration: Latest champion gets injected into other islands periodically
//   - Benchmark: Best bot is always tested against original random DNA
//
// Key terms:
//   - Genome/DNA: Float32Array of all neural network weights for pickup/meld/runner/discard nets
//   - Island: Independent population evolving separately (enables diversity)
//   - Elite: Best genome from an island generation
// ──────────────────────────────────────────────────────────────────────────────

import fs from 'fs';
import path from 'path';
import { Worker } from 'worker_threads';
import { cpus } from 'os';
import { AI_CONFIG, computeNetConfig, DEFAULT_NET_PARAMS, MAX_WEIGHTS } from '../buraco-client/src/game.js';

const NUM_WORKERS = Math.max(1, cpus().length - 1); 
const WORKER_PATH = new URL('./worker.js', import.meta.url).pathname; 

// Default hard cap on any single weight/bias magnitude. GA mutation can otherwise
// inflate weights without bound (observed |w| up to ~22), saturating the nets.
// Configurable per training run via params.weightClip (0 disables the clamp).
const WEIGHT_CLIP = 5.0;

const BOTS_DIR = path.join(process.cwd(), 'bots');
if (!fs.existsSync(BOTS_DIR)) fs.mkdirSync(BOTS_DIR, { recursive: true });

const activeTrainings = new Map();
const stopFlags = new Set();

function gaussianRandom() {
    let u, v;
    do { u = Math.random(); } while (u === 0);
    do { v = Math.random(); } while (v === 0);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function mutate(genome, mutationRate = 0.05, mutationStrength = 0.1, weightClip = WEIGHT_CLIP) {
    const mutated = new Float32Array(genome);
    for (let i = 0; i < mutated.length; i++) {
        if (Math.random() < mutationRate) {
            mutated[i] += gaussianRandom() * mutationStrength;
        }
        if (weightClip > 0) {
            if (mutated[i] > weightClip) mutated[i] = weightClip;
            else if (mutated[i] < -weightClip) mutated[i] = -weightClip;
        }
    }
    return mutated;
}

function breedNodeLevel(parentA, parentB, scoreA, scoreB, netConfig, weightClip = WEIGHT_CLIP) {
    const child = new Float32Array(parentA.length);
    const pA = Math.max(scoreA - scoreB + 1, 0.1);
    const pB = Math.max(scoreB - scoreA + 1, 0.1);
    const total = pA + pB;
    const probA = pA / total;
    const C = netConfig || AI_CONFIG;

    const nets = [
        { dna: 'DNA_CURRENT', inp: 'NN_CURRENT_INPUTS', out: 'NN_CURRENT_OUTPUTS' },
        { dna: 'DNA_SEQ',     inp: 'NN_SEQ_INPUTS',     out: 'NN_SEQ_OUTPUTS' },
        { dna: 'DNA_RUN',     inp: 'NN_RUN_INPUTS',     out: 'NN_RUN_OUTPUTS' },
        { dna: 'DNA_DISCARD', inp: 'NN_DISCARD_INPUTS', out: 'NN_DISCARD_OUTPUTS' },
    ];

    let off = 0;
    for (const net of nets) {
        const layers = [C[net.inp], ...Array.from({ length: C.hiddenLayers }, () => C.hiddenWidth), C[net.out]];
        for (let l = 0; l < layers.length - 1; l++) {
            const inSz = layers[l];
            const outSz = layers[l + 1];
            for (let o = 0; o < outSz; o++) {
                const src = Math.random() < probA ? parentA : parentB;
                const wStart = off + o * inSz;
                for (let i = 0; i < inSz; i++) child[wStart + i] = src[wStart + i];
                const bIdx = off + outSz * inSz + o;
                child[bIdx] = src[bIdx];
            }
            off += inSz * outSz + outSz;
        }
    }
    return mutate(child, 0.05, 0.05, weightClip);
}

const generateRandomGenome = (netConfig) => {
    const C = netConfig || AI_CONFIG;
    const nets = [
        { dna: 'DNA_CURRENT', inp: 'NN_CURRENT_INPUTS', out: 'NN_CURRENT_OUTPUTS' },
        { dna: 'DNA_SEQ',     inp: 'NN_SEQ_INPUTS',     out: 'NN_SEQ_OUTPUTS' },
        { dna: 'DNA_RUN',     inp: 'NN_RUN_INPUTS',     out: 'NN_RUN_OUTPUTS' },
        { dna: 'DNA_DISCARD', inp: 'NN_DISCARD_INPUTS', out: 'NN_DISCARD_OUTPUTS' },
    ];

    const g = new Float32Array(C.TOTAL_DNA_SIZE);
    let off = 0;
    for (const net of nets) {
        const layers = [C[net.inp], ...Array.from({ length: C.hiddenLayers }, () => C.hiddenWidth), C[net.out]];
        for (let l = 0; l < layers.length - 1; l++) {
            const inSz = layers[l];
            const outSz = layers[l + 1];
            const scale = 1 / Math.sqrt(inSz);
            const weightCount = inSz * outSz;
            const biasCount = outSz;
            const totalParams = weightCount + biasCount;
            for (let i = 0; i < totalParams; i++) {
                g[off + i] = gaussianRandom() * scale;
            }
            off += totalParams;
        }
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

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const nC2 = (n) => (n * (n - 1)) / 2;

function genomesEqual(a, b) {
    if (a === b) return true;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

function dedupGenomes(arrays) {
    const out = [];
    for (const g of arrays) {
        if (g && !out.some(e => genomesEqual(e, g))) out.push(g);
    }
    return out;
}

// Expected number of matches in a (partial) round-robin of n bots where each bot plays at most `max`
// opponents. 0 / >= n-1 → full round-robin C(n,2).
function partialRRMatchCount(n, max) {
    if (max <= 0 || max >= n - 1) return nC2(n);
    const perRound = n % 2 === 1 ? (n - 1) / 2 : n / 2;
    return Math.min(perRound * max, nC2(n));
}

// Builds a partial round-robin schedule as [i, j] pairs (i < j) over n bots such that each bot plays
// at most `max` matches against distinct opponents. 0 / >= n-1 → full round-robin. Uses the circle
// method: schedule n-1 rounds where no opponent ever repeats, then take only the first `max` rounds
// (a -1 "bye" pads odd-sized fields). Even n → every bot plays exactly `max`; odd n → max or max-1.
function buildPartialRRPairs(n, max) {
    if (max <= 0 || max >= n - 1) {
        const pairs = [];
        for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) pairs.push([i, j]);
        return pairs;
    }
    const order = shuffle(Array.from({ length: n }, (_, i) => i));
    if (n % 2 === 1) order.push(-1);
    const m = order.length;
    const pairs = [];
    for (let r = 0; r < max && r < n - 1; r++) {
        for (let i = 0; i < m / 2; i++) {
            const a = order[i];
            const b = order[m - 1 - i];
            if (a !== -1 && b !== -1) pairs.push(a < b ? [a, b] : [b, a]);
        }
        order.splice(1, 0, order.pop());
    }
    return pairs;
}

function toBuffer(genome, netConfig) {
    const totalSize = (netConfig || AI_CONFIG).TOTAL_DNA_SIZE;
    const buf = new SharedArrayBuffer(totalSize * 4);
    new Float32Array(buf).set(genome);
    return buf;
}

class WorkerPool {
    constructor(size, path) {
        this.queue = [];
        this._timings = { buildStateVector: 0, buildDiscardVector: 0, forwardPass: 0, getAllValidMelds: 0, getAllValidAppends: 0, planTurn: 0, planTurnCalls: 0, _evalCount: 0, _copyMs: 0 };
        this.workers = Array.from({ length: size }, () => {
            const w = new Worker(path, { workerData: { matches: [], rules: {} } });
            w.idle = true;
            w.on('message', (msg) => {
                if (!w.currentJob) return;
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

    run(matchPairs, rules, netConfig, deck = null) {
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
                this.queue.push({ matches: chunk, rules, netConfig, deck, offset, allResults, remaining, onDone });
            this._dispatch();
        });
    }

    _dispatch() {
        for (const w of this.workers) {
            if (!w.idle || this.queue.length === 0) continue;
            const job = this.queue.shift();
            w.idle = false;
            w.currentJob = { ...job, size: job.matches.length };
            w.postMessage({ matches: job.matches, rules: job.rules, netConfig: job.netConfig, deck: job.deck });
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

function runMatchBatch(matchPairs, rules, netConfig, deck = null) {
    return getPool().run(matchPairs, rules, netConfig, deck);
}

export async function runDebugMatch(dna, rules = {}, netConfig) {
    const [[scoreA, scoreB, rawA, rawB]] = await runMatchBatch(
        [{ dnaA: dna, dnaB: dna }], { ...rules, debugLog: true }, netConfig
    );
    return { scoreA, scoreB, rawA, rawB };
}

// Resolve the full net config for a bot (from its meta.json netParams, or defaults).
function getBotNetConfig(botName) {
    const metaPath = path.join(BOTS_DIR, `${botName}.meta.json`);
    try {
        if (fs.existsSync(metaPath)) {
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
            if (meta?.netParams) return computeNetConfig(meta.netParams);
        }
    } catch (e) {}
    return computeNetConfig(DEFAULT_NET_PARAMS);
}

export function getBotNetParamsSync(botName) {
    return TrainerService.getBotNetParams(botName);
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
        const totalSize = getBotNetConfig(botName).TOTAL_DNA_SIZE;
        return arr.length > totalSize ? arr.slice(0, totalSize) : arr;
    },

    getBotNetParams: (botName) => {
        const metaPath = path.join(BOTS_DIR, `${botName}.meta.json`);
        if (!fs.existsSync(metaPath)) return null;
        try {
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
            return meta?.netParams || null;
        } catch (e) {
            return null;
        }
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

    startTraining: async (botName, rules = {}, params = {}, netParams) => {
        if (activeTrainings.has(botName)) throw new Error(`Training already in progress for: ${botName}`);

        const netConfig = computeNetConfig(netParams || params.netParams || DEFAULT_NET_PARAMS);
        if (netConfig.TOTAL_DNA_SIZE * 2 > MAX_WEIGHTS) {
            throw new Error(`Network too large: DNA=${netConfig.TOTAL_DNA_SIZE}, needs ${netConfig.TOTAL_DNA_SIZE * 2} floats but buffer max is ${MAX_WEIGHTS}`);
        }
        console.log(`🧠 Net config: layers=${netConfig.hiddenLayers} width=${netConfig.hiddenWidth} SEQ=${netConfig.NN_SEQ_INPUTS} RUN=${netConfig.NN_RUN_INPUTS} CUR=${netConfig.NN_CURRENT_INPUTS} totalDNA=${netConfig.TOTAL_DNA_SIZE}`);

        const POPULATION_SIZE = Math.max(8, params.populationSize || 24);
        const GENERATIONS = params.generations || 500;
        const SAVE_EVERY = params.saveInterval || params.matchesPerGeneration || 12;
        const weightClip = params.weightClip != null ? params.weightClip : WEIGHT_CLIP;
        if (params.greedyMode     != null) rules = { ...rules, greedyMode:          params.greedyMode };
        if (params.scoreCardPoints != null) rules = { ...rules, scoreCardPoints:     params.scoreCardPoints };
        if (params.scoreHandPenalty!= null) rules = { ...rules, scoreHandPenalty:    params.scoreHandPenalty };
        if (params.dirtyCanastraBonus!=null)rules = { ...rules, dirtyCanastraBonus:  params.dirtyCanastraBonus };
        if (params.cleanCanastraBonus!=null)rules = { ...rules, cleanCanastraBonus:  params.cleanCanastraBonus };
        if (params.mortoPenalty    != null) rules = { ...rules, mortoPenalty:        params.mortoPenalty };
        if (params.endGameBonus    != null) rules = { ...rules, endGameBonus:        params.endGameBonus };
        if (params.cardPointValues != null) rules = { ...rules, cardPointValues:     params.cardPointValues };
        if (params.meldSizeBonus   != null) rules = { ...rules, meldSizeBonus:       params.meldSizeBonus };

        const NUM_ISLANDS = Math.max(2, cpus().length - 1);

        // Island-evolution tuning (persisted to meta.json trainParams).
        // Normal islands: RR#1 over the whole population on one shared shuffle ranks the field,
        // the top ADVANCE advance, and RR#2 on a fresh shuffle picks the top NUM_CHAMPIONS.
        const ADVANCE = Math.max(4, params.advanceCount || Math.floor(POPULATION_SIZE / 2));
        const NUM_CHAMPIONS = Math.min(4, Math.max(2, params.numChampions || 4));
        const BATTLE_ROYALE_SHUFFLES = Math.max(1, params.battleRoyaleShuffles || 3);
        // 0 = full round-robin (each bot plays every other); otherwise cap matches per bot per RR stage.
        const ROUND_ROBIN_MATCHES = Math.max(0, params.roundRobinMatches || 0);

        // Champion arena sizing: each normal island publishes its top `championsPerIsland` genomes
        // at every milestone. Island 0's battle royale (candidates from all islands + its kept elite
        // + the saved champion) is auto-sized so its per-milestone load lands just below a normal
        // island's (SAVE_EVERY × (RR#1 + RR#2) matches).
        const normalIslandMilestoneLoad = SAVE_EVERY * (
            partialRRMatchCount(POPULATION_SIZE, ROUND_ROBIN_MATCHES) +
            partialRRMatchCount(ADVANCE, ROUND_ROBIN_MATCHES)
        );
        const championIslandBudget = 0.95 * normalIslandMilestoneLoad;
        let maxRoyaleCandidates = 2;
        while (BATTLE_ROYALE_SHUFFLES * nC2(maxRoyaleCandidates + 1) <= championIslandBudget) maxRoyaleCandidates++;
        const championsPerIsland = params.championsPerIsland != null && params.championsPerIsland > 0
            ? Math.max(1, params.championsPerIsland)
            : Math.max(1, Math.min(
                Math.ceil((maxRoyaleCandidates - (NUM_CHAMPIONS + 1)) / (NUM_ISLANDS - 1)),
                ADVANCE
            ));

        const seedDNA = TrainerService.getBotWeights(botName);
        const originalDNA = generateRandomGenome(netConfig);

        const metaPath = path.join(BOTS_DIR, `${botName}.meta.json`);
        const existingMeta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf-8')) : null;
        const lifetimeGenOffset = existingMeta?.lifetimeGenerations || 0;

        if (seedDNA) {
            console.log(`🤖 Resuming training for '${botName}'...`);
        } else {
            console.log(`🤖 Starting fresh training for '${botName}'...`);
        }

        const loadIslandSeed = (k) => {
            const fp = path.join(BOTS_DIR, `${botName}_${k}.json`);
            if (fs.existsSync(fp)) {
                const raw = JSON.parse(fs.readFileSync(fp, 'utf-8'));
                const arr = Array.isArray(raw) ? raw : Object.values(raw);
                return new Float32Array(arr.length === netConfig.TOTAL_DNA_SIZE ? arr : arr.slice(0, netConfig.TOTAL_DNA_SIZE));
            }
            if (seedDNA) {
                const arr = Array.isArray(seedDNA) ? seedDNA : Array.from(seedDNA);
                return new Float32Array(arr.length === netConfig.TOTAL_DNA_SIZE ? arr : arr.slice(0, netConfig.TOTAL_DNA_SIZE));
            }
            return generateRandomGenome(netConfig);
        };

        activeTrainings.set(botName, {
            currentGeneration: 0, totalGenerations: GENERATIONS,
            lifetimeGenOffset,
            benchmarkDiff: null,
            islands: []
        });

        const baseDeck = [];
        for (let i = 0; i < 52; i++) baseDeck.push(i);
        for (let i = 0; i < 52; i++) baseDeck.push(i);
        if (!rules.noJokers) baseDeck.push(54, 54);

        const islandPops = Array.from({ length: NUM_ISLANDS }, (_, k) => {
            const seed = loadIslandSeed(k);
            return Array.from({ length: POPULATION_SIZE }, (_, i) =>
                i === 0 ? new Float32Array(seed) : mutate(seed, 0.05, 0.1, weightClip)
            );
        });

        // championPool[k] = top `championsPerIsland` genomes published by normal island k at its last milestone
        const championPool = new Array(NUM_ISLANDS).fill(null);
        const publishedGen = new Array(NUM_ISLANDS).fill(0);
        const islandDone = new Array(NUM_ISLANDS).fill(false);
        // Island 0 (arena) keeps its top-NUM_CHAMPIONS unmutated between battle royales
        let keptArenaElites = [];
        const islandLastInjectedGen = new Array(NUM_ISLANDS).fill(0);
        let latestChampion = null;
        let lastBenchmarkTime = Date.now();
        const roundStartTimes = new Map();

        const fmt = ms => ms < 60000 ? `${(ms/1000).toFixed(1)}s` : `${Math.floor(ms/60000)}m${((ms%60000)/1000).toFixed(0)}s`;

        // Two-stage round-robin island generation.
        // RR#1: full round-robin on one shared deck shuffle ranks the whole population; the top
        // ADVANCE advance. RR#2: those ADVANCE play a fresh-shuffle round-robin; the top
        // NUM_CHAMPIONS become this island's champions for the next generation and the arena pool.
        const runIslandGeneration = async (pop, weightClip) => {
            const rr1Pairs = [], rr1Meta = [];
            for (const [i, j] of buildPartialRRPairs(pop.length, ROUND_ROBIN_MATCHES)) {
                rr1Pairs.push({ dnaA: toBuffer(pop[i], netConfig), dnaB: toBuffer(pop[j], netConfig) });
                rr1Meta.push([i, j]);
            }
            const allDiffs = [];
            const scores1 = new Array(pop.length).fill(0);
            if (rr1Pairs.length > 0) {
                const rr1Deck = shuffle([...baseDeck]);
                const results1 = await runMatchBatch(rr1Pairs, rules, netConfig, rr1Deck);
                results1.forEach(([sA, , rawA, rawB], idx) => {
                    const [i, j] = rr1Meta[idx];
                    allDiffs.push(rawA, rawB);
                    scores1[i] += sA;
                    scores1[j] -= sA;
                });
            } else { allDiffs.push(0); }

            const ranked1 = pop
                .map((g, i) => ({ genome: g, score: scores1[i] }))
                .sort((a, b) => b.score - a.score);
            const advanced = ranked1.slice(0, ADVANCE);

            const rr2Pairs = [], rr2Meta = [];
            for (const [i, j] of buildPartialRRPairs(advanced.length, ROUND_ROBIN_MATCHES)) {
                rr2Pairs.push({ dnaA: toBuffer(advanced[i].genome, netConfig), dnaB: toBuffer(advanced[j].genome, netConfig) });
                rr2Meta.push([i, j]);
            }
            const scores2 = new Array(advanced.length).fill(0);
            if (rr2Pairs.length > 0) {
                const rr2Deck = shuffle([...baseDeck]);
                const results2 = await runMatchBatch(rr2Pairs, rules, netConfig, rr2Deck);
                results2.forEach(([sA], idx) => {
                    const [i, j] = rr2Meta[idx];
                    scores2[i] += sA;
                    scores2[j] -= sA;
                });
            }

            const ranked2 = advanced
                .map((x, i) => ({ genome: x.genome, score: scores2[i] }))
                .sort((a, b) => b.score - a.score);
            const champs = ranked2.slice(0, NUM_CHAMPIONS);

            // next population: NUM_CHAMPIONS unmutated clones + fillers cycling the pairwise crosses
            // of the champions, then single-parent mutations of each champion until full.
            const nextPop = champs.map(c => new Float32Array(c.genome));
            const pairCrosses = [];
            for (let i = 0; i < champs.length; i++)
                for (let j = i + 1; j < champs.length; j++)
                    pairCrosses.push(breedNodeLevel(champs[i].genome, champs[j].genome, champs[i].score, champs[j].score, netConfig, weightClip));
            const numCrosses = Math.round((pop.length - champs.length) * 0.6);
            let ci = 0;
            while (pairCrosses.length > 0 && nextPop.length < champs.length + numCrosses) {
                nextPop.push(new Float32Array(pairCrosses[ci % pairCrosses.length]));
                ci++;
            }
            let mi = 0;
            while (nextPop.length < pop.length) {
                nextPop.push(mutate(champs[mi % champs.length].genome, 0.05, 0.1, weightClip));
                mi++;
            }

            return {
                nextPop,
                ranked2,
                bestDiff: allDiffs.length > 0 ? Math.max(...allDiffs) : 0,
                avgDiff: allDiffs.reduce((a, b) => a + b, 0) / (allDiffs.length || 1)
            };
        };

        const writeChampionMeta = (champion) => {
            const currentLifetimeGen = lifetimeGenOffset + (activeTrainings.get(botName)?.currentGeneration || 0);
            fs.writeFileSync(path.join(BOTS_DIR, `${botName}.meta.json`), JSON.stringify({
                rules, netParams, lifetimeGenerations: currentLifetimeGen,
                trainParams: {
                    populationSize: POPULATION_SIZE, generations: GENERATIONS, saveInterval: SAVE_EVERY, weightClip,
                    advanceCount: ADVANCE, numChampions: NUM_CHAMPIONS, battleRoyaleShuffles: BATTLE_ROYALE_SHUFFLES, championsPerIsland,
                    roundRobinMatches: ROUND_ROBIN_MATCHES,
                    greedyMode: params.greedyMode, telepathy: params.telepathy, fixedDeck: params.fixedDeck,
                    scoreCardPoints: params.scoreCardPoints, scoreHandPenalty: params.scoreHandPenalty,
                    dirtyCanastraBonus: params.dirtyCanastraBonus, cleanCanastraBonus: params.cleanCanastraBonus,
                    mortoPenalty: params.mortoPenalty, endGameBonus: params.endGameBonus,
                    cardPointValues: params.cardPointValues, meldSizeBonus: params.meldSizeBonus
                }
            }));
        };

        // Champion arena battle royale: all published champions from normal islands ∪ kept arena
        // elites ∪ the saved champion (deduped), played as a round-robin under BATTLE_ROYALE_SHUFFLES
        // fresh deck shuffles, scores summed. The winner is promoted (monotonic by construction — the
        // saved champion is inside the round-robin). Returns the new kept arena elite (top-NUM_CHAMPIONS).
        const runBattleRoyale = async (roundGen = 0) => {
            const royaleStart = Date.now();
            const roundStart = roundStartTimes.get(roundGen) ?? royaleStart;
            let kept = keptArenaElites;

            const collected = [];
            for (let k = 1; k < NUM_ISLANDS; k++)
                if (championPool[k]) collected.push(...championPool[k]);
            const saved = TrainerService.getBotWeights(botName);
            const savedGenome = (saved && saved.length === netConfig.TOTAL_DNA_SIZE)
                ? new Float32Array(saved) : null;
            const candidates = dedupGenomes([...keptArenaElites, ...(savedGenome ? [savedGenome] : []), ...collected]);
            if (candidates.length === 0) return kept;

            if (candidates.length === 1) {
                latestChampion = new Float32Array(candidates[0]);
                kept = [new Float32Array(candidates[0])];
            } else {
                const wins = new Array(candidates.length).fill(0);
                for (let s = 0; s < BATTLE_ROYALE_SHUFFLES; s++) {
                    const rrDeck = shuffle([...baseDeck]);
                    const pairs = [];
                    for (let i = 0; i < candidates.length; i++)
                        for (let j = i + 1; j < candidates.length; j++)
                            pairs.push({ i, j, dnaA: toBuffer(candidates[i], netConfig), dnaB: toBuffer(candidates[j], netConfig) });
                    const results = await runMatchBatch(pairs, rules, netConfig, rrDeck);
                    results.forEach(([sA], idx) => {
                        wins[pairs[idx].i] += sA;
                        wins[pairs[idx].j] -= sA;
                    });
                }

                const ranked = candidates
                    .map((g, i) => ({ genome: g, score: wins[i] }))
                    .sort((a, b) => b.score - a.score);
                latestChampion = new Float32Array(ranked[0].genome);
                kept = ranked.slice(0, NUM_CHAMPIONS).map(r => new Float32Array(r.genome));
            }

            fs.writeFileSync(path.join(BOTS_DIR, `${botName}.json`), JSON.stringify(Array.from(latestChampion)));
            writeChampionMeta(latestChampion);

            let benchmarkDiff = null;
            if (originalDNA) {
                try {
                    const benchDeck = [...baseDeck];
                    shuffle(benchDeck);
                    getPool().broadcastDeck(benchDeck);
                    const [[benchScore]] = await runMatchBatch(
                        [{ dnaA: toBuffer(latestChampion, netConfig), dnaB: toBuffer(originalDNA, netConfig) }],
                        { ...rules, fixedDeck: true }, netConfig
                    );
                    benchmarkDiff = benchScore;
                } catch (e) {}
            }
            const prev = activeTrainings.get(botName);
            if (prev) activeTrainings.set(botName, { ...prev, benchmarkDiff });

            const royaleMs = Date.now() - royaleStart;
            const roundMs = Date.now() - roundStart;
            const elapsedMs = Date.now() - lastBenchmarkTime;
            lastBenchmarkTime = Date.now();
            console.log(`[${botName}] 🏆 Battle Royale (round ${roundGen}): ${candidates.length} candidates | Champion promoted | Bench: ${benchmarkDiff ?? 'N/A'} | ⏱ ${fmt(elapsedMs)} since last | Royale: ${fmt(royaleMs)} | Round: ${fmt(roundMs)}`);
            roundStartTimes.delete(roundGen);
            return kept;
        };

        // Island 0 = champion arena. Idle between milestones; once every normal island has published
        // at a milestone, run a battle royale. Runs the final battle royale when all islands finish.
        const runChampionIsland = async () => {
            try {
                const milestones = [];
                for (let m = SAVE_EVERY; m < GENERATIONS; m += SAVE_EVERY) milestones.push(m);
                if (GENERATIONS % SAVE_EVERY !== 0) milestones.push(GENERATIONS);
                if (milestones.length === 0) milestones.push(GENERATIONS);

                let mi = 0;
                while (!stopFlags.has(botName)) {
                    const allDone = islandDone.slice(1).every(d => d);
                    if (mi < milestones.length && publishedGen.slice(1).every(g => g >= milestones[mi])) {
                        keptArenaElites = await runBattleRoyale(milestones[mi]);
                        mi++;
                        continue;
                    }
                    if (allDone) break;
                    await sleep(1000);
                }
                // Final battle royale if some milestones never fired (early stop / island errors).
                if (!stopFlags.has(botName) && mi < milestones.length) {
                    keptArenaElites = await runBattleRoyale(milestones[mi]);
                }
            } catch (err) {
                islandErrors.push(err);
                console.error(`[TRAINER] Champion island error:`, err);
            } finally {
                completedIslands++;
                islandDone[0] = true;
            }
        };


        let completedIslands = 0;
        const islandErrors = [];

        const runIsland = async (islandIdx) => {
            try {
                for (let gen = 1; gen <= GENERATIONS; gen++) {
                    if (stopFlags.has(botName)) break;
                    const result = await runIslandGeneration(islandPops[islandIdx], weightClip);
                    islandPops[islandIdx] = result.nextPop;

                    if (gen % SAVE_EVERY === 0 || gen === GENERATIONS) {
                        if (latestChampion && gen - islandLastInjectedGen[islandIdx] >= SAVE_EVERY) {
                            const replaceIdx = 2 + Math.floor(Math.random() * (islandPops[islandIdx].length - 2));
                            islandPops[islandIdx][replaceIdx] = new Float32Array(latestChampion);
                            islandLastInjectedGen[islandIdx] = gen;
                        }

                        // publish this island's top champions to the arena pool
                        championPool[islandIdx] = result.ranked2
                            .slice(0, championsPerIsland)
                            .map(x => new Float32Array(x.genome));
                        publishedGen[islandIdx] = gen;

                        fs.writeFileSync(
                            path.join(BOTS_DIR, `${botName}_${islandIdx}.json`),
                            JSON.stringify(Array.from(result.ranked2[0].genome))
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
                        const mspt = t.planTurnCalls > 0 ? (t.planTurn / t.planTurnCalls).toFixed(2) : '?';
                        //console.log(`[${botName}] [TIMING/${SAVE_EVERY}gens] planTurn=${(t.planTurn||0).toFixed(0)}ms (${mspt}ms/turn) turns=${t.planTurnCalls||0}`);
                    }
                }
            } catch (err) {
                islandErrors.push(err);
                console.error(`[TRAINER] Island ${islandIdx} error:`, err);
            } finally {
                completedIslands++;
                islandDone[islandIdx] = true;
            }
        };

        try {
            await Promise.allSettled([
                runChampionIsland(),
                ...Array.from({ length: NUM_ISLANDS - 1 }, (_, k) => runIsland(k + 1))
            ]);
            if (islandErrors.length) console.error(`[TRAINER] ${islandErrors.length} island(s) failed for ${botName}`);
        } catch (error) {
            console.error(`[TRAINER] Error for ${botName}:`, error);
        } finally {
            console.log(`Training complete for '${botName}'!`);
            if (_pool) { _pool.terminate(); _pool = null; }
            activeTrainings.delete(botName);
            stopFlags.delete(botName);
        }
    }
};
