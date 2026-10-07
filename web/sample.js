const lane = (id, x, title) => ({ id, x, y: 0, w: 288, h: 720, title });

function card(id, laneX, order, text, color, notes) {
  return { id, x: laneX + 24, y: 72 + order * 96, w: 240, text, color, ...(notes ? { notes } : {}) };
}

export function sampleBoard() {
  return {
    lanes: [lane("l-todo", 0, "To do"), lane("l-doing", 336, "Doing"), lane("l-done", 672, "Done")],
    cards: [
      card("c-offsite", 0, 0, "Plan the offsite\nVenue, dates, budget", 1, "Ask about the place in Lisbon.\nKeep it under 40 people.\nBudget sign-off by the 20th."),
      card("c-hiring", 0, 1, "Review the hiring loop", 3),
      card("c-goals", 0, 2, "Write Q4 goals\nDraft before Friday", 1),
      card("c-flaky", 0, 3, "Fix the flaky login test", 2),
      card("c-dentist", 0, 4, "Book the dentist", 5),
      card("c-proto", 336, 0, "Touch prototype\nDoes it feel right?", 4, "Use it for a day.\nNote what feels wrong."),
      card("c-relnotes", 336, 1, "Release notes 2.3", 1),
      card("c-interview", 336, 2, "Interview: backend role\nThursday 14:00", 3),
      card("c-search", 672, 0, "Ship search", 4),
      card("c-ci", 672, 1, "Migrate CI", 4),
      card("c-retro", 672, 2, "Team retro", 5),
      { id: "c-ideas", x: 1008, y: 72, w: 240, text: "Ideas\nArrows between cards?\nImages?", color: 5 },
      { id: "c-pinch", x: 1008, y: 216, w: 240, text: "Pinch to zoom, hold to lift", color: 1 },
      { id: "c-rams", x: 1008, y: 312, w: 240, text: "Read: Less but better", color: 3, notes: "Ten principles.\nGood design is as little design as possible." },
    ],
  };
}

function random(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 500 cards: ten lanes of 30 and 200 loose, as scripts/make-stress-board.py makes for the Mac. */
export function stressBoard() {
  const r = random(1);
  const int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  const pick = (a) => a[Math.floor(r() * a.length)];
  const words = "Kafka Task Matches Interview Firms View Training Trip Plan Review Budget Sprint Client Offer Release Bug Idea".split(" ");
  const phrase = (n) => Array.from({ length: n }, () => pick(words)).join(" ");
  const lanes = [];
  const cards = [];
  for (let l = 0; l < 10; l++) {
    lanes.push({ id: `l${l}`, x: l * 504, y: 0, w: 288, h: 2400, title: `Lane ${l}` });
    let y = 72;
    for (let k = 0; k < 30; k++) {
      const n = pick([1, 1, 2, 3, 4]);
      const text = Array.from({ length: n }, () => phrase(int(1, 3))).join("\n");
      cards.push({ id: `c${l}_${k}`, x: l * 504 + 24, y, w: 240, text, color: int(1, 5) });
      y += (n + 1) * 24 + 24;
    }
  }
  for (let k = 0; k < 200; k++) {
    cards.push({ id: `f${k}`, x: int(-100, 99) * 24, y: int(110, 199) * 24, w: 240, text: phrase(3), color: int(1, 5) });
  }
  return { cards, lanes };
}
