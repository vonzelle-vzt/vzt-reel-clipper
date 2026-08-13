/**
 * Sport profiles — everything the pipeline needs to know that differs between
 * sports, in one table.
 *
 * The editing doctrine (hook first, cut on the beat, build/slow/rebuild) is
 * universal; the *vocabulary* is not. A basketball highlight is a dunk, a
 * lacrosse highlight is a shot on goal, and the two sports don't even share a
 * play cadence: basketball flows continuously while football resets on every
 * snap. Hardcoding one sport's language into the scorer would quietly make the
 * tool useless for the other ten.
 *
 * So each profile carries:
 *  - `highlights` / `broll` / `outro` — CLIP search phrases, written as visual
 *    descriptions because that is what CLIP matches on
 *  - `preroll` / `postroll` / `minGap` — the play window and spacing implied by
 *    the sport's cadence
 *  - `minShotBeats` — how long an action shot must hold for the play to READ.
 *    This is sport-specific: a dunk is legible in a second, a deep pass needs
 *    the throw, the ball in flight and the catch, which is several times longer.
 *    Too short and the viewer sees a flicker of bodies and no play.
 *  - `deadBall` — extra stoppage vocabulary on top of the shared list
 *  - `continuous` — flowing play vs. reset-every-play, which changes pacing
 *
 * Add a sport by adding an entry; nothing else in the pipeline needs to change.
 */

// Shared across every sport — the human moments that make a reel more than a
// highlight tape ("no one wants to just see a straight highlight tape").
const COMMON_BROLL = [
  "players warming up before the game",
  "team huddle",
  "crowd cheering in the stands",
  "close up of a player's face",
  "coach on the sideline",
  "players walking onto the field",
  "teammates reacting on the bench",
];

const COMMON_OUTRO = [
  "players celebrating together",
  "handshake line after the game",
  "team huddle after the game",
  "player raising a trophy",
];

/** Stoppage language that means the same thing in every sport. */
export const COMMON_DEAD_BALL = [
  "dead ball",
  "no active possession",
  "no live action",
  "not live",
  "minimal live action",
  "largely a stoppage",
  "break in play",
  "between plays",
];

export const PROFILES = {
  basketball: {
    label: "Basketball",
    continuous: true,
    preroll: 4, postroll: 3, minGap: 12,
    minShotBeats: 4,
    highlights: [
      "basketball player dunking the ball",
      "basketball player shooting a three pointer",
      "basketball player driving to the basket for a layup",
      "basketball player blocking a shot",
      "basketball crossover dribble move",
    ],
    deadBall: ["free throw", "inbound", "timeout huddle"],
  },
  football: {
    label: "Football",
    continuous: false,
    // A pass play is snap → drop back → throw → ball in flight → catch, and it
    // runs 4-7s. The window is anchored on the START of the play (see
    // burstOnsetBefore in score.js), so `preroll` here is the run-up kept
    // before the snap and `postroll` has to be long enough to still be rolling
    // at the catch. Anchoring mid-play is what made earlier cuts open after the
    // throw and close before the catch.
    preroll: 2, postroll: 7, minGap: 14,
    minShotBeats: 4,
    highlights: [
      "a football player catching a ball",
      "a quarterback throwing a football",
      "a player running with a football",
      "a receiver jumping for a pass",
      "a football player making a tackle",
    ],
    deadBall: ["huddle", "timeout", "penalty flag", "measurement", "lining up"],
  },
  "flag-football": {
    label: "Flag Football",
    continuous: false,
    preroll: 2, postroll: 6, minGap: 12,
    minShotBeats: 4,
    highlights: [
      "a player pulling a flag",
      "a football player catching a ball",
      "a quarterback throwing a football",
      "a player running with a football",
    ],
    deadBall: ["huddle", "timeout", "lining up", "penalty"],
  },
  // 7-on-7 / passing league: no linemen, no run game, every play is a pass.
  // Plays come fast and the whole point is the throw and the catch.
  "7v7": {
    label: "7-on-7",
    continuous: false,
    preroll: 2, postroll: 6, minGap: 10,
    minShotBeats: 4,
    highlights: [
      "a football player catching a ball",
      "a quarterback throwing a football",
      "a receiver jumping for a pass",
      "a player running with a football",
      "a defender breaking up a pass",
    ],
    deadBall: ["huddle", "lining up", "walking back", "between plays"],
  },
  soccer: {
    label: "Soccer",
    continuous: true,
    preroll: 7, postroll: 5, minGap: 25,
    minShotBeats: 6,
    highlights: [
      "soccer player shooting on goal",
      "soccer goalkeeper diving to make a save",
      "soccer player heading the ball",
      "soccer player making a slide tackle",
      "soccer players celebrating a goal",
    ],
    deadBall: ["throw in", "corner kick setup", "substitution", "free kick setup"],
  },
  lacrosse: {
    label: "Lacrosse",
    continuous: true,
    preroll: 5, postroll: 4, minGap: 15,
    minShotBeats: 5,
    highlights: [
      "lacrosse player shooting on goal",
      "lacrosse goalie making a save",
      "lacrosse players checking each other",
      "lacrosse faceoff at midfield",
      "lacrosse ground ball scramble",
    ],
    deadBall: ["substitution", "restart", "timeout"],
  },
  baseball: {
    label: "Baseball",
    continuous: false,
    preroll: 4, postroll: 5, minGap: 20,
    minShotBeats: 6,
    highlights: [
      "baseball batter hitting the ball",
      "baseball pitcher throwing a pitch",
      "baseball player making a diving catch",
      "baseball player sliding into a base",
      "baseball player rounding the bases after a home run",
    ],
    deadBall: ["between innings", "mound visit", "batter stepping out"],
  },
  softball: {
    label: "Softball",
    continuous: false,
    preroll: 4, postroll: 5, minGap: 20,
    minShotBeats: 6,
    highlights: [
      "softball batter hitting the ball",
      "softball pitcher windmill pitching",
      "softball player making a diving catch",
      "softball player sliding into a base",
    ],
    deadBall: ["between innings", "circle visit", "batter stepping out"],
  },
  volleyball: {
    label: "Volleyball",
    continuous: true,
    preroll: 4, postroll: 3, minGap: 12,
    minShotBeats: 4,
    highlights: [
      "volleyball player spiking the ball at the net",
      "volleyball player blocking at the net",
      "volleyball player diving to dig the ball",
      "volleyball player serving",
    ],
    deadBall: ["rotation", "timeout", "substitution"],
  },
  hockey: {
    label: "Hockey",
    continuous: true,
    preroll: 5, postroll: 4, minGap: 15,
    minShotBeats: 5,
    highlights: [
      "hockey player taking a slap shot",
      "hockey goalie making a save",
      "hockey player delivering a body check",
      "hockey players celebrating a goal",
    ],
    deadBall: ["faceoff setup", "line change", "whistle stoppage"],
  },
  wrestling: {
    label: "Wrestling",
    continuous: false,
    preroll: 5, postroll: 5, minGap: 20,
    minShotBeats: 5,
    highlights: [
      "wrestler executing a takedown",
      "wrestler pinning an opponent",
      "referee raising a wrestler's hand in victory",
    ],
    deadBall: ["between periods", "resetting in the center", "stalling"],
  },
  track: {
    label: "Track & Field",
    continuous: false,
    preroll: 3, postroll: 6, minGap: 30,
    minShotBeats: 6,
    highlights: [
      "sprinter exploding out of the starting blocks",
      "runner crossing the finish line",
      "athlete doing a long jump",
      "relay runners handing off the baton",
      "athlete throwing shot put or discus",
    ],
    deadBall: ["between events", "walking to the start", "setting up"],
  },
  tennis: {
    label: "Tennis",
    continuous: false,
    preroll: 4, postroll: 3, minGap: 15,
    minShotBeats: 4,
    highlights: [
      "tennis player serving",
      "tennis player hitting a forehand winner",
      "tennis player diving for a volley",
    ],
    deadBall: ["between points", "changeover", "towel off"],
  },
  generic: {
    label: "Generic",
    continuous: true,
    preroll: 5, postroll: 4, minGap: 15,
    minShotBeats: 5,
    highlights: [
      "athlete making an impressive athletic play",
      "player scoring",
      "players competing intensely",
      "athlete celebrating after a big play",
    ],
    deadBall: [],
  },
};

/** Every sport key, for CLI help and validation. */
export const SPORT_KEYS = Object.keys(PROFILES);

/**
 * Resolve a sport name to its profile. Unknown or omitted → `generic`, so a
 * user who never passes --sport still gets a working reel.
 */
export function getProfile(sport) {
  const key = String(sport || "generic").toLowerCase().trim();
  const p = PROFILES[key] || PROFILES.generic;
  return {
    key: PROFILES[key] ? key : "generic",
    ...p,
    broll: p.broll || COMMON_BROLL,
    outro: p.outro || COMMON_OUTRO,
    deadBallTerms: [...COMMON_DEAD_BALL, ...(p.deadBall || [])],
  };
}
