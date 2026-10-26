"use strict";

// Pure rules shared by the service worker and isolated content scripts.
globalThis.__weAgoDomain ||= Object.freeze({
  skill(skills, key) {
    return key === "criticalDamage" || key === "criticalDamages"
      ? skills?.criticalDamage ?? skills?.criticalDamages : skills?.[key];
  },
  investment(skill) {
    const finite = value => typeof value === "number" && Number.isFinite(value);
    if (finite(skill)) return skill >= 0 ? skill : null;
    if (!skill || typeof skill !== "object" || Array.isArray(skill)) return null;
    const invested = skill.investedPoints ?? skill.points ?? skill.investedLevels;
    if (finite(invested) && invested >= 0) return invested;
    const level = skill.level ?? skill.tier, base = skill.baseLevel ?? skill.baseTier ?? 0;
    return finite(level) && level >= 0 && finite(base) ? Math.max(0, level - base) : null;
  },
  classify(user) {
    const skills = user?.skills;
    if (!skills || typeof skills !== "object" || Array.isArray(skills)) return null;
    let recognized = 0;
    const score = keys => keys.reduce((sum, key) => {
      const skill = this.skill(skills, key);
      if (skill === undefined) return sum;
      const value = this.investment(skill);
      if (value === null) throw Object.assign(new Error("Skill investment format unavailable. Try refreshing later."), { code: "UNKNOWN_SKILLS" });
      recognized++;
      return sum + value;
    }, 0);
    const combatScore = score(["attack", "precision", "criticalChance", "criticalDamage", "armor", "dodge", "health", "hunger"]);
    const ecoScore = score(["energy", "companies", "management", "entrepreneurship", "production"]);
    if (!recognized) return null;
    const combatShare = combatScore + ecoScore ? combatScore / (combatScore + ecoScore) : null;
    return { combatScore, ecoScore, combatShare,
      build: combatShare === null ? "unallocated" : combatShare >= .65 ? "damage" : combatShare <= .35 ? "eco" : "hybrid" };
  }
});
