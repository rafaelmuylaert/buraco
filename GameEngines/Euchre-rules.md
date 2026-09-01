# Bid Euchre — Rules Reference

This is the ruleset for Bid Euchre, a 4-player partnership trick-taking card game.
The rules follow traditional Eastern North American Euchre, as implemented in the engine.

## Overview

- **Players:** 4 (two partnerships of 2).
- **Cards:** 24-card deck — 9, 10, J, Q, K, A of each suit (4 suits × 6 ranks).
  Extended variants add an 8th rank for a 32-card deck.
- **Rank (high → low):** A K Q J 10 9 (8 in the 32-card variant).
- **Type:** partnership trick-taking game with upcard bidding and special bowler cards.

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

## Bidding

Bidding determines the trump suit. Players decide clockwise whether to pick up the upcard, or pass.
The first to bid is the player after the dealer.

### Round 1: Pick up or pass

- A player may say **"pick up"** (or "play the upcard"), accepting the upcard's suit as trump.
  The picker becomes the **declarer** and the game proceeds to the call phase.
- A player may **pass** during bidding, declining to pick up the upcard.
- Bidding proceeds clockwise until someone picks up the upcard.

### All pass → Round 2: Name trump

- If all four players pass in Round 1, the game enters **bidRound2**.
- Players bid clockwise from dealer+1. Any player may **name a suit** as trump (except the upcard's suit).
  The first to name a suit becomes the **declarer**.
- If all players pass until it reaches the dealer (the last to act), the dealer is **forced** to become
  the declarer and must name a trump suit.

### Play alone (open)

- After becoming declarer (by picking up or naming trump), the declarer may declare **"alone"** (open solo).
- This is announced during the **call phase** via `declareSoloMove`.
- The positional partner's hand is emptied — they play no cards but still receive points.
- Scoring: solo make = +1 each, solo march = +4 each, solo euchred = defenders +2 each.

## Call phase (declarer's actions)

After the bidding ends, the declarer has the following options:

1. **Declare alone** — The declarer may announce solo play at any point before play begins.
   This is done via `declareSoloMove`. The partner's hand is emptied.

2. **Pick up the upcard** (Round 1 only) — If the upcard was picked up during bidding,
   the upcard is added to the declarer's hand and they **must choose one card to discard**
   via `chooseDiscardMove`. The discarded card goes to the kitty.

3. **Continue to play** (Round 2 only) — If no upcard was picked up (Round 2 bidding),
   the declarer skips the discard step via `continueCallMove` and play begins immediately.

When the declarer picks up the upcard:
- The upcard's suit becomes trump.
- The upcard is stored as `G.calledCard` (informational only).
- One card from the declarer's hand is discarded.
- The game then transitions to the play phase.

### Positional partnership

The declarer's partner is fixed by seat, not by card holding: seat 0 ↔ seat 2
and seat 1 ↔ seat 3 (0-indexed, i.e. player 1↔player 3, player 2↔player 4).
`computePartner` returns `(declarer + 2) % numPlayers`. Even when the declarer
plays alone, points are still applied to both that player and the positional
partner.

## Play

- The player after the dealer leads the first trick.
- Players must **follow suit** if possible.
- **Bowler exception:** For all purposes, the Left Bowler is considered to be of trump suit.
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

Scoring is per-hand and **not** zero-sum. It is purely based on tricks won,
**not** on point-cards. Each seat on a side gets the full side amount (the
declarer and their positional partner both score the same amount; the same
applies to the two defenders).

### Partnership scoring

| Outcome | Declarer's team (each seat) | Defenders (each seat) |
|---------|----------------|-----------|
| Make contract (win 3 or 4 tricks) | +1 | 0 |
| March (win all 5 tricks) | +2 | 0 |
| Euchred (win fewer than 3 tricks) | 0 | +2 |
| March (when playing alone) | +4 | 0 |

### Match play

- The game is played as **best-of matches** up to `winPoints` (default 5).
- First team to reach `winPoints` wins the match.
- In the 5-point game, a side is said to be "at the bridge" when it has scored 4
  and the opponents have scored 2 or less.

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
- **Positional partner.** The partner is fixed by seat: `(declarer + 2) %
  numPlayers`. It is never stored in `G` and needs no card holding — a seat
  opposite the declarer is always the partner.
- **No-trump handling.** When `G.trump === NO_TRUMP` (no trump chosen),
  bowlers have no special power. In practice this means the upcard was
  passed by all players and the hand is redone.
- **Real-time turn sequence.** The engine does not use a random dealer per
  hand — the dealer is set at setup time and rotations are handled by the
  lobby/controller.
- **euchre.js** uses the shared engine (`TrickGames.js`) with game-specific
  overrides for card value, bowler detection, and scoring.
- **Non-zero-sum scoring.** Points are not normalized to a zero sum; the two
  seats of the winning side each get the full side amount and the losing side
  gets 0 (see the scoring table above).