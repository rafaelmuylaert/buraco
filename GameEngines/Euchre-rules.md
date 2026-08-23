# Bid Euchre — Rules Reference

This is the exact ruleset implemented by `euchre.js`. Bid Euchre is a classic 4-player
trick-taking card game (typically played in two partnerships). The rules below follow
the traditional Eastern North American rules, as implemented in the engine.

## Overview

- **Players:** 2–4 (standard is 4, playing two partnerships of 2).
- **Cards:** 24-card deck — 9, 10, J, Q, K, A of each suit (4 suits × 6 ranks).
  An extended 32-card variant adds an 8th rank (8 and one additional card).
- **Rank (high → low):** A K Q J 10 9 (8, in the extended variant).
- **Type:** partnership trick-taking game with upcard bidding and special "bowler"
  cards (jacks).

## Card composition

| Suit | Char | Colour |
|------|------|--------|
| Spades | ♠ | Black |
| Hearts | ♥ | Red |
| Clubs | ♣ | Black |
| Diamonds | ♦ | Red |

## Special cards: the Bowlers

In Euchre, the Jacks have elevated status and may act as trumps regardless of suit.

| Card | Name | Rank among trumps |
|------|------|-------------------|
| J of trump suit | **Right Bowler** (Right) | Highest card in the game, above the Ace of trump |
| J of same colour as trump | **Left Bowler** (Left) | Second-highest trump, below the Right Bowler but above the Ace of its own suit |

For example, if hearts are trump:
- **Right Bowler** = J♥ (highest card overall)
- **Left Bowler** = J♦ (J of the other red suit, second-highest overall)

If spades are trump:
- **Right Bowler** = J♠
- **Left Bowler** = J♣

When no trump is chosen, there are no bowlers.

### Card ranking within trump

| Order | Card | Description |
|-------|------|-------------|
| 1 (highest) | Right Bowler | J of the trump suit |
| 2 | Left Bowler | J of the same colour |
| 3 | A of trump | Highest normal trump |
| 4 | 10 of trump | |
| 5 | K of trump | |
| 6 | Q of trump | |
| 7 | 9 of trump | |

### Card ranking off-suit (non-trump)

Cards that are not trump rank normally within their suit:
- A > K > Q > J > 10 > 9 (or A > K > Q > J > 10 > 9 > 8 in the 32-card variant)

## The upcard

After all cards are dealt, one card is turned face-up on the table. Its suit
becomes trump for the round **if** someone picks it up during bidding.

## Deal

- Shuffle the 24 cards, deal **5 cards to each player**, and place **1 card face-up**
  as the upcard (with 23 remaining in the stock).
- The dealer is chosen at random and rotates clockwise each hand.

## Bidding (upcard selection)

Bidding is simplified compared to the traditional four-suit version: players
decide whether to pick up the upcard, play alone, or pass.

### Pick up (accept trump)
- A player says **"pick up"** (or "play the upcard"), accepting the upcard's suit
  as trump.
- The picker becomes the **declarer** and picks up the upcard.
- The picker's team then plays to win the hand.

### Beauty 10 (bid 10)
- If the upcard is a **10**, a player may say **"Beauty 10"** (bid 10 points),
  which is the highest possible bid. The beauty 10 accepts the upcard as trump
  and guarantees the contract.

### Play alone
- A player may declare **"alone"** (playing solo), declaring that they will win
  the hand without any partner. This doubles the stakes.
- In the engine, alone is announced during the call phase.

### Pass
- A player may **pass** during bidding, declining to pick up the upcard.
- Bidding proceeds clockwise until all remaining players have passed or someone
  picks up the upcard.

### All pass → redeal
- If all four players pass, the hand is **redone**: cards are re-shuffled and
  re-dealt by the same dealer.
- This repeats until someone picks up the upcard (or bids beauty 10).

## Call phase (declarer's actions)

After the bidding ends, the declarer (who picked up or was the last to act) has
the option to:

1. **Pick up** — take the upcard into their hand and discard one card, accepting
   the upcard's suit as trump.
2. **Call a partner** — the declarer calls a card not in their hand, and the
   player holding it becomes their partner (the "called card" mechanic).
3. **Play alone** — announce solo play. In the engine, alone is tracked via the
   `openAlone` flag and the `calledCard` field.

When the declarer picks up the upcard:
- The upcard's suit becomes trump.
- The upcard is stored as `G.calledCard` (used for partner assignment).
- One card from the declarer's hand is discarded.

## Play

- The **declarer leads the first trick**.
- Players must **follow suit** if possible.
- **Bowler exception:** the Right and Left Bowlers (trump Jacks) may be played
  at any time, even when the player can follow the led suit or has no trumps.
  This lets bowlers "cross-trump" — beating any other trump regardless of rank.
- If a player cannot follow suit, they may:
  - Play a trump (overtrump)
  - Play a bowler
  - Play any card (a "put-down" or "dirty throw")
- The trick is won by:
  1. The **Right Bowler** (if present)
  2. The **Left Bowler** (if present and no Right Bowler played)
  3. The **highest trump** card
  4. The **highest card of the led suit** (if no trump was played)
- The trick winner leads the next trick. Play continues until all 5 tricks are taken.

## Scoring

Scoring is zero-sum, per-hand. The declarer's team (declarer + partner) tries to
win the contract; the defenders try to prevent it.

### Traditional Euchre scoring

| Outcome | Declarer's team score | Defenders' score |
|---------|----------------------|------------------|
| Make contract (win 10+ point-cards) | +1 | -1 |
| Make + Schneider (defenders get < 40pts) | +2 | -2 |
| Make + Schwarz (defenders get 0pts) | +3 | -3 |
| Euchred (fail contract) | -1 | +1 |
| Alone + made | +2 | -2 |
| Alone + Schneider | +4 | -4 |
| Alone + Schwarz | +6 | -6 |
| Alone + Euchred | -2 | +2 |

### Point-cards

Each card has a point value:
| Card | Points |
|------|--------|
| A | 4 |
| 10 | 3 |
| K | 2 |
| Q | 1 |
| J of trump | 1 |
| J of non-trump | 0 |
| All other cards | 0 |

A contract requires the declarer's team to win at least **10 points** total from
the 5 tricks taken.

### Match play

- The game is played as **best-of matches** up to `winPoints` (default 5).
- Each hand awards points as described above.
- First team to reach `winPoints` wins the match.

### Solo scoring

When the declarer plays alone:
- All points are doubled.
- Even when alone, a partner may be "called" (secret or open).
- If no partner exists (true solo), defenders are all other players.

## Variant: Bid Euchre

Bid Euchre differs from standard Euchre in the bidding mechanism:

1. **Points-based bidding:** instead of simply "pick up" or "pass", players bid
   a point total (1–10). The bid represents the points the declarer's team
   promises to win.
2. **Beating a bid:** a player can beat a bid by calling a higher point total,
   or by "beautifying" (if the upcard is a 10).
3. **Minimum bid:** 1 point (the "pick up" bid).
4. **Maximum bid:** 10 points ("Beauty 10" or full contract).

This adds strategic depth — players can evaluate their hand strength and
contribute or decline based on their confidence.

## Implemented choices & simplifications

- **Upcard-only bidding.** The engine does not implement multi-round bidding
  (a second round with trump suits revealed). Players either pick up the upcard
  or pass.
- **5 tricks per hand.** Each player receives 5 cards; each hand has exactly 5
  tricks.
- **Single upcard.** Only 1 upcard is dealt (24-card deck), unlike Mighty's
  3-card kitty.
- **Bowler free-play.** Right and Left Bowlers can be played at any time
  (even when able to follow suit), per traditional rules.
- **Partner derived from called card.** The partner is never stored in `G`;
  it is determined dynamically by which player holds the `calledCard` when
  that card is eventually played. This ensures no secret state leaks.
- **No-trump handling.** When `G.trump === NO_TRUMP` (no trump chosen),
  bowlers have no special power. In practice this means the upcard was
  passed by all players and the hand is redone.
- **Real-time turn sequence.** The engine does not use a random dealer per
  hand — the dealer is set at setup time and rotations are handled by the
  lobby/controller.
- **euchre.js** uses the shared engine (`TrickGames.js`) with game-specific
  overrides for card value, bowler detection, and scoring.
- **Scoring normalization.** The final score delta is normalized so that the
  sum of all player scores is always zero (zero-sum game).