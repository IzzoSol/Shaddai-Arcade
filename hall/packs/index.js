'use strict';
/**
 * hall/packs/index.js — the Hall's pack registry. hall/routes.js looks up
 * `PACKS[match.pack]` here; adding a new pack is a one-line addition, no
 * route changes needed.
 *
 * CORRECTION vs. Shaddai-Arcade issue #10's original text: it names the 4
 * titles as "basketball/football/dodgeball/sigil-storm". The actual
 * shaddai-games roster (its own README, "Playable Now") is Gridiron
 * (football), Neon Hoops (basketball), Dodgeball, and Starfall -- there is
 * no "sigil-storm" title in that repo. Wired up as Starfall below; flag to
 * the owner if "sigil-storm" was meant to be a 5th, not-yet-built title.
 */

const blackjack = require('./blackjack');
const skate = require('./skate');
const { makeSkillplayBetPack } = require('./skillplay-bet');

// Council-vs-council exhibition pairings for phase-1 -- arbitrary but fixed,
// so the same match id always resolves the same way (determinism holds
// end-to-end, not just inside skillplay-client.js). Real "pick your own
// contenders" seat/roster selection is a real next increment, not phase-1.
const hoops_bet = makeSkillplayBetPack('hoops_bet', {
  game: 'hoops', label: 'Neon Hoops', contenderA: 'NEXUS', contenderB: 'PIKADON',
});
const gridiron_bet = makeSkillplayBetPack('gridiron_bet', {
  game: 'gridiron', label: 'Gridiron', contenderA: 'ZEROX', contenderB: 'TURTLE',
});
const dodgeball_bet = makeSkillplayBetPack('dodgeball_bet', {
  game: 'dodgeball', label: 'Dodgeball', contenderA: 'ORACLE', contenderB: 'QUILL',
});
const starfall_bet = makeSkillplayBetPack('starfall_bet', {
  game: 'shooting', label: 'Starfall', contenderA: 'SHADDAI', contenderB: 'NEXUS',
});

module.exports = { blackjack, skate, hoops_bet, gridiron_bet, dodgeball_bet, starfall_bet };
