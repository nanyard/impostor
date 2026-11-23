export const MIN_PLAYERS = 4;
export const DELIBERATION_MS = 5 * 60 * 1000;
export const IMPOSTOR_THRESHOLD = 7;
export const IMPOSTOR_COOLDOWN_ROUNDS = 2;
export const MAX_IMPOSTOR_STREAK = 2;
export const INNOCENT_POINTS = 5;
export const IMPOSTOR_SURVIVAL_POINTS = 15;
export const IMPOSTOR_TARGET_POINTS = 30;

export function getImpostorCount(playerCount) {
  return playerCount >= IMPOSTOR_THRESHOLD ? 2 : 1;
}

export function shuffle(items, random = Math.random) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

export function pickRandom(items, random = Math.random) {
  if (!items.length) return null;
  return items[Math.floor(random() * items.length)];
}

export function selectImpostors(players, count, random = Math.random) {
  const safeCount = Math.max(0, Math.min(count, players.length));
  const eligible = players.filter(
    (player) => (player.cooldown ?? 0) <= 0 && (player.streak ?? 0) < MAX_IMPOSTOR_STREAK,
  );
  const chosen = shuffle(eligible, random).slice(0, safeCount);
  const forcedIds = [];

  if (chosen.length < safeCount) {
    const chosenIds = new Set(chosen.map((player) => player.id));
    const remaining = shuffle(
      players.filter((player) => !chosenIds.has(player.id)),
      random,
    ).sort((a, b) => {
      const cooldownDiff = (a.cooldown ?? 0) - (b.cooldown ?? 0);
      if (cooldownDiff !== 0) return cooldownDiff;
      const streakDiff = (a.streak ?? 0) - (b.streak ?? 0);
      if (streakDiff !== 0) return streakDiff;
      return (a.lastImpostorRound ?? -1) - (b.lastImpostorRound ?? -1);
    });

    for (const player of remaining) {
      if (chosen.length >= safeCount) break;
      chosen.push(player);
      forcedIds.push(player.id);
    }
  }

  return {
    ids: chosen.map((player) => player.id),
    forcedIds,
  };
}

export function selectTarget(players, impostorIds, random = Math.random) {
  const impostorSet = new Set(impostorIds);
  const innocents = players.filter((player) => !impostorSet.has(player.id));
  return pickRandom(innocents, random)?.id ?? null;
}

export function pickWord(
  wordData,
  categoryIds,
  usedKeys = [],
  hintUsage = {},
  random = Math.random,
) {
  const selectedCategories = wordData.categories.filter((category) =>
    categoryIds.includes(category.id),
  );
  const allWords = selectedCategories.flatMap((category) =>
    category.words.map((entry) => ({
      categoryId: category.id,
      categoryName: category.name,
      key: `${category.id}:${entry.word}`,
      word: entry.word,
      hints: [...entry.hints],
    })),
  );

  if (!allWords.length) {
    throw new Error('No words are available for the selected categories.');
  }

  const used = new Set(usedKeys);
  let available = allWords.filter((entry) => !used.has(entry.key));
  let reset = false;
  if (!available.length) {
    available = allWords;
    reset = true;
  }

  const picked = pickRandom(available, random);
  const usage = hintUsage[picked.key] ?? 0;
  const hintIndex = picked.hints.length ? usage % picked.hints.length : 0;

  return {
    categoryId: picked.categoryId,
    categoryName: picked.categoryName,
    key: picked.key,
    word: picked.word,
    hints: picked.hints,
    hintIndex,
    hint: picked.hints[hintIndex] ?? '',
    nextHintUsage: usage + 1,
    reset,
  };
}

export function calculateRoundResult(players, round, votedOutId) {
  const impostorSet = new Set(round.impostorIds);
  const caught = impostorSet.has(votedOutId);
  const targetHit = round.targetId === votedOutId;
  const points = {};
  const reasons = {};

  for (const player of players) {
    points[player.id] = 0;
    reasons[player.id] = 'No points this round';
  }

  if (caught) {
    for (const player of players) {
      if (impostorSet.has(player.id)) {
        reasons[player.id] = 'Caught as impostor';
      } else {
        points[player.id] = INNOCENT_POINTS;
        reasons[player.id] = 'Impostor caught';
      }
    }
  } else {
    for (const player of players) {
      if (impostorSet.has(player.id)) {
        points[player.id] = targetHit ? IMPOSTOR_TARGET_POINTS : IMPOSTOR_SURVIVAL_POINTS;
        reasons[player.id] = targetHit ? 'Target voted out' : 'Impostor survived';
      }
    }
  }

  return {
    skipped: false,
    votedOutId,
    caught,
    targetHit,
    categoryName: round.categoryName,
    word: round.word,
    impostorIds: [...round.impostorIds],
    targetId: round.targetId,
    points,
    reasons,
  };
}

export function applyImpostorHistory(players, round) {
  const impostorSet = new Set(round.impostorIds);

  for (const player of players) {
    if (impostorSet.has(player.id)) {
      player.streak = (player.streak ?? 0) + 1;
      player.lastImpostorRound = round.number;
      player.cooldown = player.streak >= MAX_IMPOSTOR_STREAK ? IMPOSTOR_COOLDOWN_ROUNDS : 0;
    } else if ((player.cooldown ?? 0) > 0) {
      player.cooldown -= 1;
      if (player.cooldown === 0) player.streak = 0;
    } else {
      player.streak = 0;
    }
  }
}

export function finalizeRound(players, round, { skipped = false, votedOutId = null } = {}) {
  if (skipped) {
    return { skipped: true, result: null };
  }

  const result = calculateRoundResult(players, round, votedOutId);
  for (const player of players) {
    player.score = (player.score ?? 0) + (result.points[player.id] ?? 0);
  }
  applyImpostorHistory(players, round);
  return { skipped: false, result };
}

export function formatTime(milliseconds) {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function validateWordData(data) {
  if (!data || !Array.isArray(data.categories) || data.categories.length === 0) {
    throw new Error('Word data is missing categories.');
  }

  const categoryIds = new Set();
  const wordKeys = new Set();

  for (const category of data.categories) {
    if (!category || typeof category.id !== 'string' || !category.id.trim()) {
      throw new Error('A category is missing an id.');
    }
    if (typeof category.name !== 'string' || !category.name.trim()) {
      throw new Error(`Category "${category.id}" is missing a name.`);
    }
    if (categoryIds.has(category.id)) {
      throw new Error(`Duplicate category id "${category.id}".`);
    }
    categoryIds.add(category.id);

    if (!Array.isArray(category.words) || !category.words.length) {
      throw new Error(`Category "${category.name}" has no words.`);
    }

    for (const entry of category.words) {
      if (!entry || typeof entry.word !== 'string' || !entry.word.trim()) {
        throw new Error(`Category "${category.name}" has an invalid word.`);
      }
      if (
        !Array.isArray(entry.hints) ||
        entry.hints.length < 2 ||
        entry.hints.length > 3 ||
        entry.hints.some((hint) => typeof hint !== 'string' || !hint.trim())
      ) {
        throw new Error(`Word "${entry.word}" needs 2–3 non-empty hints.`);
      }
      const key = `${category.id}:${entry.word}`;
      if (wordKeys.has(key)) {
        throw new Error(`Duplicate word "${entry.word}" in category "${category.name}".`);
      }
      wordKeys.add(key);
    }
  }

  return data;
}
