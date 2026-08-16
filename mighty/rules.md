# Mighty — Rules Reference

This is the exact ruleset implemented by `mighty/game.js`. Mighty is the Korean
5-player trick-taking game (also known among Korean university circles); the
rules below follow the pagat.com "Mighty" article, with the specific choices and
simplifications in the game noted at the end.

## Overview

- **Players:** 5.
- **Cards:** standard 52-card deck + 1 Joker (53 cards).
- **Rank (high → low):** A K Q J 10 9 8 7 6 5 4 3 2. The 10, J, Q, K, A of each
  suit are **point cards**, worth 1 point each — 20 points in the pack.
- **Type:** point-trick game with bidding, secret partnership, and three special cards.

## Special cards

| Card | Name | Normal | If the round's trump changes it |
|------|------|--------|---------------------------------|
| A♠ | **Mighty** | the highest card | A♦ becomes the Mighty if spades are trump |
| Joker | **Joker** | second-highest card | — |
| 3♣ | **Ripper** (Joker-Hunter) | rips the Joker | 3♠ becomes the Ripper if clubs are trump |

- **Mighty** — highest card in the game; wins any trick it is played to. May be
  played any time, even ignoring the follow-suit rule. If the Mighty is led, the
  other players must follow its suit if they can.
- **Joker** — beats everything except the Mighty. When it is *led*, the leader
  names a suit that everyone else must follow (the Joker still wins unless the
  Mighty is played). The Joker cannot be played to the **first or last trick**.
- **Ripper** — when the Ripper is *led*, whoever holds the Joker must play it
  (or the Mighty, if they hold that instead). When the Joker and the Ripper are
  in the same trick, the Ripper **rips** the Joker: it loses all power and cannot
  win the trick. The Ripper cannot rip the Joker on the first trick.

## Deal

- Shuffle 53 cards, deal **10 cards to each player**, and place the remaining
  **3 cards face-down as the kitty**.
- The first dealer is chosen at random. (In live play the highest cut deals; the
  holder of the called card deals the next hand — a single hand is played per
  match here.)

## Bidding

- Bidding starts with the dealer and moves clockwise.
- A bid names a **point total (13–20)** and a **trump suit** (♠ ♥ ♣ ♦) or **no
  trump**.
- The first bid must be at least 13. Each later bid must be **higher**: strictly
  more points, *or* the same points with **no trump** (no-trump outranks a suit
  bid of the same value).
- A player may **pass** instead of bidding; a passed player cannot bid again that
  round.
- Bidding continues (wrapping around) until only one player has not passed; that
  player is the **declarer** and wins the last (highest) bid.
- If everyone passes, a **second round** of bidding is played. If everyone passes
  again, the hand is a **misdeal**: the cards are re-shuffled and re-dealt, and
  bidding starts over with the same dealer.

## The kitty and calling a partner

- The declarer picks up the 3 kitty cards, then discards **3 cards face-down**
  back to the kitty (so they keep 10).
- The declarer then **calls a partner** by naming one card that is *not* in their
  hand. The player holding that card is the declarer's secret **friend/partner**.
- The partnership is **secret**: only the partner knows they are the partner
  (they hold the called card). Everyone else learns who it is when the called
  card is played (or at the end of the hand).
- **Playing alone:** the declarer may announce **"no friend"** openly, call a card
  in their own hand, or call a card that is sitting in the kitty — in the last two
  cases the declarer plays alone *secretly* (the other players only discover it
  when the called card never appears).

## Play

- The **declarer leads the first trick**, but may **not** lead a trump, the Joker,
  or the Ripper on the first trick.
- Players must **follow suit** if they can. Exceptions:
  - The Mighty or the Joker may be played at any time, even when able to follow suit.
  - If a player cannot follow suit, they play any card.
  - If the Ripper is led, the Joker holder is compelled to play the Joker (or the Mighty).
- The trick is won by (highest priority first):
  1. the **Mighty**;
  2. the **Joker** (unless it was ripped);
  3. the **highest trump**;
  4. the **highest card of the led suit**.
- The trick winner leads the next trick. Play continues until all 10 tricks are taken.

## Scoring

- The declarer's team is the declarer plus the partner (or just the declarer if
  playing alone); everyone else defends.
- Count the point cards (10/J/Q/K/A) captured by the **declarer's team**. There
  are 20 points in total.
- **Success** = the team captured **at least** the bid. Otherwise the defenders win.
- Settlement is zero-sum, with the declarer paying/winning **twice** as much as
  the partner:
  - 2 vs 3: each defender pays/receives `bid`; partner pays/receives `bid`;
    declarer pays/receives `2×bid`.
  - 1 vs 4 (alone): each defender pays/receives `bid`; the declarer
    pays/receives `4×bid`.

## Implemented choices & simplifications

- **One hand per match.** When the 10th trick ends, the game is over and the
  settlement is shown. Multi-hand scoring and "dealer = holder of the called
  card" are not implemented.
- **Hidden information** matches live play: each player only sees their own hand,
  the declarer alone sees the kitty, and the declarer's captured pile is shown as
  a face-down count (defenders' piles are face-up). The partner is never stored —
  it is derived from who plays the called card.
- **No-trump beats a suit bid at equal points**; same-point suit-vs-suit raises
  are not allowed (a common house-rule variant — see pagat "Variations").
- **Ripper rips the Joker whenever both are in the same trick** (not only when
  the Ripper leads), except on the first trick. When the Joker is ripped in a
  Joker-led trick, the trick goes to the highest trump, else the highest card of
  the *named* suit.
- **First-trick lead restriction** is relaxed in the impossible edge case where
  the declarer's whole hand after the kitty discard consists only of trump,
  Joker, and Ripper — then any card may be led.
- If the Joker is a player's only card on the last trick, it may be played
  (forced) despite the normal restriction.
- The "20 no-trump + name the partner's suit" advanced call is **not** implemented.
