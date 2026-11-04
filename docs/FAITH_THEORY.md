# Faith Theory

*An Axelrod tournament where the players are kinds of faith.*

In 1980 Robert Axelrod invited game theorists to submit strategies for a
repeated Prisoner's Dilemma. Fourteen entries played every other entry, their
own twin, and a random player for 200 moves. Anatol Rapoport's **Tit for Tat**
(cooperate first, then copy your partner's last move) won. A second tournament
had 62 entries, and Tit for Tat won again. Axelrod's explanation was that it is
*nice* (never the first to defect), *retaliatory*, *forgiving*, and *clear*.
Later work showed that once moves can misfire, more forgiving strategies such as
Generous Tit for Tat and Win-Stay Lose-Shift beat it (Nowak & Sigmund 1992,
1993).

Faith Theory asks the same question with a different cast. Every player is an
archetype of faith taken from Scripture. Each archetype is tested twice:

* **Under the sun** (Ecclesiastes' phrase): only the game itself.
* **Under heaven**: four biblical promises are written into the rules, each
  scaled by a strength *s* between 0 and 1.

The interactive lab is at **`/faith`** in the app (`public/faith/index.html`).
Every number below can be regenerated with `npm run faith`; the full tables are
in [`faith-theory-results.md`](faith-theory-results.md).

---

## 1. The Covenant Game

At every step, each player meets every other player once and either **keeps
covenant** (cooperates) or **betrays** (defects). The payoffs are Axelrod's.

|                       | They keep covenant | They betray |
| :--                   | :--                | :--         |
| **You keep covenant** | 3 · blessing       | 0 · betrayed |
| **You betray**        | 5 · spoil          | 1 · famine  |

## 2. Faith as a strategy

> Even so faith, if it hath not works, is dead, being alone. (James 2:17)

Each player has a **faith level F** between 0 and 1. On each move:

1. Its **rule** (its conscience) recommends keeping covenant or holding back:
   * `allc`: always keep covenant.
   * `tft`: keep covenant first, then answer the partner's last move.
   * `stft`: hold back first ("except I see"), then answer the last move.
   * `wsls`: win-stay lose-shift. If the partner kept covenant, repeat your own
     last move; otherwise switch.
2. If the rule says keep covenant, the player does so with probability
   `F × (1 − greed)`.
3. If the rule says retaliate, the player shows mercy with probability
   `F × mercy`.
4. With probability `noise`, the move misfires ("time and chance happeneth to
   them all", Eccl 9:11).

Faith is **global**: each player carries it from one relationship into the next.
After every step it moves according to how the player was treated (`c` is the
share of partners who kept covenant with it):

```
F ← F + sightUp · c · (1 − F) − sightDown · (1 − c) · F        (walking by sight)
```

**Undulating** faith also has its own tide: `F_eff = F + wave · sin(2πt/period + φ)`.

## 3. The cast

| Archetype | Figure | Scripture | Rule | F₀ | Moves with sight (up / down) | Mercy | Also | Classic equivalent |
| :-- | :-- | :-- | :-- | --: | :-- | --: | :-- | :-- |
| Steadfast | Abraham | Rom 4:20 | allc | 1 | 0 / 0 | 1 | | Always Cooperate |
| Discerning | Joseph | Gen 50:20, Matt 10:16 | tft | 1 | 0 / 0 | ⅓ | | Generous Tit for Tat |
| Undulating | Peter on the water | Matt 14:30-31, James 1:6 | tft | 0.85 | 0.06 / 0.08 | ½ | tide ±0.3, period 24 | (new) |
| Mustard Seed | the disciples | Matt 17:20, Luke 17:5 | tft | 0.15 | 0.12 / 0.02 | ⅓ | anchor 1 | (new) |
| Eye for an Eye | the Law of Moses | Exod 21:24 | tft | 1 | 0 / 0 | 0 | | **Tit for Tat** |
| Show Me First | Thomas | John 20:25 | stft | 1 | 0 / 0 | 0 | | Suspicious Tit for Tat |
| Prodigal | the prodigal son | Luke 15:17 | wsls | 1 | 0 / 0 | 0 | | Win-Stay Lose-Shift (Pavlov) |
| Rocky Ground | seed on stony places | Matt 13:20-21 | tft | 1 | 0.003 / 0.15 | 0 | | ≈ Grim Trigger |
| Thorny Ground | Ananias & Sapphira | Acts 5:2, Matt 13:22 | tft | 1 | 0 / 0 | 0 | greed 0.1 | Joss |
| Lukewarm | Laodicea | Rev 3:15-16 | allc | 0.5 | 0 / 0 | 1 | | Random |
| No Faith | Cain | Gen 4:9 | tft | 0 | 0 / 0 | 0 | | Always Defect |

Steadfast, Discerning, Undulating and Mustard Seed have faith **anchored in God**
(restoration applies to them). The middle five rest on **trust by sight**, and
Lukewarm and No Faith have **no anchor**. Cain's rule is `tft` so that if his
heart is ever renewed (see below), he becomes a reciprocator.

## 4. Two worlds

**Under the sun** is the game alone. **Under heaven** adds four promises, each
multiplied by the strength `s`:

| Promise | Scripture | Mechanism |
| :-- | :-- | :-- |
| **Unity** | Ps 133:1, 3 | Mutual covenant pays `R = 3 + s`. |
| **Reaping** | Gal 6:7-9, Rom 12:19, Matt 5:24 | Ten steps after a betrayal ("after many days", Eccl 11:1), the betrayed receive `s·(R − S)`, but **only if they have not avenged themselves** (they are still keeping covenant with the betrayer). The betrayer pays `s·(T − R)` **unless they have been reconciled** (they are keeping covenant again). |
| **Restoration** | Ps 23:3, Luke 22:32 | Faith anchored in God moves `0.08·s` of the way back to its anchor every step. |
| **Renewal** | Ezek 36:26, Rom 12:20-21 | When you have just wronged someone and they keep covenant with you anyway, your faith rises by `0.3·s·m·(1 − F)`, where `m` is the share of partners who did this. It applies to everyone, including the hardened. |

**These are modelling choices.** The heaven results show what follows *if* the
promises work as written above. They are a thought experiment, not a measurement
of God. The sweep over `s` and the one-promise-at-a-time test exist so you can see
how much each choice matters.

## 5. The tests

Unless noted, each test uses two copies of every archetype, 200 steps, and 5%
misfires, with `s = 0.5` under heaven. Every test is seeded.

| # | Test | What it asks |
| --: | :-- | :-- |
| 1 | **Under the sun** | Axelrod's round robin with no misfires. Who wins? |
| 2 | **Time and chance** | The same tournament with 5% misfires. |
| 3 | **Under heaven** | The same tournament with the four promises at s = 0.5. |
| 3b | **How much heaven?** | Ranks as s goes from 0 to 1. |
| 3c | **Each promise alone** | Each mechanism switched on by itself at s = 1. |
| 4 | **Levels face to face** | Focused faith at 100/75/50/25/0% and undulating faith at 85/50% meet in pairs. The diagonal is each level *with its own kind*. |
| 5 | **The faith curve** | One newcomer at each level from 0% to 100% joins the full tournament. |
| 6 | **Generations** | Axelrod's ecological tournament: shares grow in proportion to score for 60 generations. |
| 7 | **Peradventure ten** (Gen 18:32) | In a city of 100 Cains, how many of each kind of faithful must live there before they out-earn the faithless? Tested scattered, and assembling together (Heb 10:25: 20% extra time with their own kind). |
| 8 | **The storm** (Matt 7:24-27) | Each archetype lives in a house of four of its own kind. After calm, 40 steps of 30% misfires, then calm again. Which houses stand? |

## 6. What came out

**1. Under the sun, Joseph wins.** With no misfires, Discerning (2.25 per move)
beats Eye for an Eye (Tit for Tat, 2.18). In the generations test it grows to
55% of the population. Leading with trust, answering wrongs, and forgiving about
one wrong in three is Axelrod's lesson, and it is also the shape of Joseph's
story: he tested his brothers before forgiving them.

**2. Once mistakes happen, forgiveness beats strict justice.** With 5% misfires,
Eye for an Eye falls from 2nd to 7th, because a single accident is repaid and the
repayment is repaid, forever. Joseph and the Prodigal take the top two places.
The storm shows the same thing starkly: the Eye for an Eye house goes from 100%
covenant to 49% and never recovers, while the houses of Joseph, Steadfast and the
Prodigal recover at once. *"Until seventy times seven"* (Matt 18:22) is what
works when the world is noisy.

**3. Undulating faith sinks by itself.** A house of four wavering believers
drifts down to 8% covenant with no storm at all. A wavering newcomer scores the
same (2.03–2.06) whatever faith it starts with, because the wind always carries
it to about 0.3. Under heaven, restoration holds the house near 55% and gives the
starting level its meaning back, but the wavering line never reaches the focused
one. In the head-to-head test, a wavering house at 85% does no better than a
steady house at 25% (1.43 against 1.40). *"A double minded man is unstable in all
his ways"* (James 1:8).

**4. Focused faith pays fully only near the top, unless heaven acts.** Under the
sun, a newcomer's score barely moves from 0% to 70% faith (2.04 to 2.10), and
most of the gain comes between 80% and 100% (to 2.22). Head to head, more faith
earns more against the faithful and less against the faithless. Under heaven,
every step of faith pays, and full faith is the best row against every partner,
including no faith (1.99 against 1.40).

**5. Turning the other cheek pays only under heaven, and reaping is what makes it
pay.** Steadfast faith comes last under the sun. It is first from s = 0.3 upward.
Switched on alone, reaping lifts Steadfast from last to first and sends Cain to
the bottom. Unity mostly rewards reciprocators, renewal redeems and warms, and
restoration by itself changes little. There is a clean result here: with only
unity and reaping, one steadfast believer among Cains out-earns them when

```
(3 + s)·s > 1   ⇔   s > 0.30
```

so heaven has to repay about a third of each wrong. The simulation crosses
between s = 0.30 and s = 0.33. Renewal lowers the bar further, because it turns
Cains into reciprocators.

**6. No faith wins early and loses late.** Cain gains share for the first five
to seven generations (9.1% → 9.7%), then falls to 0.1% by generation 60 as
the people he exploited disappear. Axelrod saw the same pattern with exploitative
entries. *"Fret not thyself because of evildoers … for they shall soon be cut
down like the grass"* (Ps 37:1-2).

**7. A few can save a city if they meet together.** Scattered among 100 Cains,
reciprocators need 5 of their kind to start spreading, and Joseph needs 43,
because his forgiveness is exploited. If they assemble together, Joseph, Eye for
an Eye and Show Me First need **one**, the Mustard Seed five and the Undulating
nine. This is Axelrod's cluster-invasion result in Hebrews 10:25's words.
Steadfast cannot spread under the sun even when assembled. From s = 0.2 almost
every kind needs only one.

**8. Leading with proof costs you.** Show Me First finishes 10th of 11 in the
plain tournament, and its house never cooperates at all, since nobody goes first.
*"Blessed are they that have not seen, and yet have believed"* (John 20:29).

**9. Under heaven the lukewarm do not stay lukewarm.** Renewal warms them (Rev
3:19, *"be zealous therefore, and repent"*), and they finish 2nd in the heaven
tournament. Rocky Ground finishes last under heaven: its faith rests on sight,
so restoration cannot reach it, and once it withers it stops keeping the
covenants that heaven rewards.

### Axelrod's advice and Scripture

| From the tournaments | From Scripture |
| :-- | :-- |
| Don't be envious. | "Fret not thyself because of evildoers, neither be thou envious." Ps 37:1 |
| Don't be the first to defect. | "As ye would that men should do to you, do ye also to them likewise." Luke 6:31 |
| Reciprocate both cooperation and defection. | "With what measure ye mete, it shall be measured to you again." Matt 7:2 |
| Don't be too clever. | "Lean not unto thine own understanding." Prov 3:5 |
| Forgive when mistakes happen (tests 2, 8). | "Until seventy times seven." Matt 18:22 |
| Meet with your own kind (test 7). | "Not forsaking the assembling of ourselves together." Heb 10:25 |
| Hold steady (tests 4, 5). | "A double minded man is unstable in all his ways." James 1:8 |
| Lead with trust (tests 1, 8). | "Blessed are they that have not seen, and yet have believed." John 20:29 |

## 7. Limits

* **The field decides.** As Axelrod found, rankings depend on who else is
  playing. The lab lets you remove players and rerun.
* **Parameters are choices.** Sight rates, tide size, mercy levels and the four
  promises' strengths are set to be recognisable, not fitted to data. The tests
  that matter most (the strength sweep, the one-promise test, and the break-even
  formula) show how results depend on them.
* **Faith here is behavioural.** "Faith" is the chance of acting on a good
  intention. That fits James 2 but leaves out most of what the word means.
* **This is not theology.** It is a way to think with the parables using the
  tools of game theory.

## 8. Run it

```bash
npm run faith        # rerun every test → public/faith/results.js + docs/faith-theory-results.md
npm run test:faith   # engine tests (classic equivalences, determinism, each promise)
npm run dev          # then open http://localhost:3000/faith
```

| File | What it is |
| :-- | :-- |
| `public/faith/engine.js` | The simulation engine (no dependencies; runs in the browser and in Node) |
| `public/faith/index.html` | The interactive lab |
| `public/faith/results.js` | Precomputed results (generated) |
| `scripts/faith-theory.mjs` | Runs every test and writes the results |
| `scripts/faith-theory.test.mjs` | Engine tests |

### References

* R. Axelrod & W. D. Hamilton, "The Evolution of Cooperation," *Science* 211 (1981).
* R. Axelrod, *The Evolution of Cooperation* (Basic Books, 1984).
* M. A. Nowak & K. Sigmund, "Tit for tat in heterogeneous populations," *Nature* 355 (1992).
* M. A. Nowak & K. Sigmund, "A strategy of win-stay, lose-shift that outperforms tit-for-tat," *Nature* 364 (1993).
* Scripture quotations are from the King James Version.
