"use strict";

(() => {
  const t = (source = "", ...values) => globalThis.__weAgoI18n?.t(source, ...values)
    ?? (typeof source === "string" ? source : source.reduce((text, part, i) => text + part + (i < values.length ? values[i] : ""), ""));

  const SLOTS = ["weapon", "helmet", "chest", "pants", "gloves", "boots"];
  const OWNED = '[data-we-ago="true"]';
  const finite = value => typeof value === "number" && Number.isFinite(value);
  const unwrap = value => value && Object.hasOwn(value, "json") ? value.json : value;
  const fmt = value => finite(value) ? value.toLocaleString(globalThis.__weAgoI18n?.locale || "en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—";
  const gearCode = code => /^(knife|gun|rifle|sniper|tank|jet|(?:helmet|chest|pants|gloves|boots)[1-6])$/.test(code || "");
  // Icon prefixes from the native stat components, independent of generated CSS.
  const ICONS = { attack: "M11,9H9V2", precision: "M19.5,3.09L20.91", criticalChance: "M4.35 21H21", criticalDamage: "M12,2A10,10 0 0,0 2,12" };

  /** Numeric skills are base values, percentages are percentage points.
   * Native {value, prestige} skills and criticalDamages are also accepted.
   * ammoTier is null (none) or a config-derived {percentAttack} object.
   * Imprecise hits deal half damage; only precise hits can crit.
   */
  function calculateExpectedDamagePerHit(playerSkills, equipmentStats, ammoTier, isPilled) {
    const p = playerSkills, e = equipmentStats;
    if (!p || !e || typeof isPilled !== "boolean") return null;
    const read = (obj, key) => globalThis.__weAgoDomain.skill(obj, key);
    const base = key => {
      const skill = read(p, key);
      return finite(skill) ? skill : finite(skill?.value) && finite(skill.prestige ?? 0) ? skill.value + (skill.prestige ?? 0) : NaN;
    };
    const total = key => base(key) + (read(e, key) ?? 0);
    const precision = total("precision"), chance = total("criticalChance");
    const po = Math.max(0, precision - 100), co = Math.max(0, chance - 100);
    const attack = total("attack") + (po ? po * p.precisionOverflowValue : 0);
    const critical = total("criticalDamage") + (co ? co * p.criticalOverflowValue : 0);
    const ammo = ammoTier == null ? 0 : ammoTier.percentAttack;
    const rank = p.militaryRankPercent ?? p.attack?.militaryRankPercent ?? 0;
    const pill = isPilled ? p.pillPercentAttack : 0;
    if (![precision, chance, attack, critical, ammo, rank, pill].every(finite)
      || [precision, chance, attack, critical, ammo, rank, pill].some(v => v < 0)) return null;
    const hitChance = Math.min(100, precision) / 100, critChance = Math.min(100, chance) / 100;
    const damage = attack * (1 + rank / 100) * (1 + ammo / 100) * (1 + pill / 100)
      * (.5 + .5 * hitChance + hitChance * critChance * critical / 100);
    return finite(damage) ? damage : null;
  }

  function equipmentSkills(equipment) {
    if (!equipment || typeof equipment !== "object" || Array.isArray(equipment)) return null;
    const result = {};
    for (const slot of SLOTS) {
      const item = equipment[slot];
      if (item == null) continue;
      if (typeof item !== "object" || Array.isArray(item) || !item.skills || typeof item.skills !== "object" || Array.isArray(item.skills)
        || item.state !== undefined && (!finite(item.state) || item.state <= 0)) return null;
      for (const key of ["attack", "precision", "criticalChance", "criticalDamage", "armor", "dodge"]) {
        const value = globalThis.__weAgoDomain.skill(item.skills, key) ?? 0;
        if (!finite(value) || value < 0) return null;
        result[key] = (result[key] ?? 0) + value;
      }
    }
    return result;
  }

  function sequenceCosts(unbuffed, pilled, pillPrice, ammoPrice, hits) {
    if (![unbuffed, pilled, pillPrice, ammoPrice, hits].every(finite)
      || unbuffed <= 0 || pilled <= 0 || pillPrice < 0 || ammoPrice < 0 || !Number.isInteger(hits) || hits < 1 || hits > 1000000) return null;
    // One pill per explicitly chosen sequence, one ammo per attempted hit.
    return { unbuffed: 0, pilled: (pillPrice + ammoPrice * hits) / (pilled * hits) * 1000 };
  }

  function bountyRate(battleId, side, battle, orders, now = Date.now(), damage = 1000) {
    if (battle?._id !== battleId || battle.isActive !== true) return null;
    const native = battle[side];
    const rows = Array.isArray(orders) ? orders : orders?.items ?? orders?.orders;
    const candidates = [native, ...(Array.isArray(rows) ? rows : []).filter(order => order?.battle === battleId && order.side === side)];
    let best = null;
    for (const order of candidates) {
      if (!order || order.isActive === false || order.status && order.status !== "active") continue;
      if (order.bountyEffectiveAt && !(Date.parse(order.bountyEffectiveAt) <= now)
        || order.expiresAt && !(Date.parse(order.expiresAt) > now)) continue;
      const rate = order.moneyPer1kDamages ?? order.rewardPer1kDamage ?? order.perK;
      const pool = order.moneyPool ?? order.remainingBudget;
      // A loaded side with no bounty fields has no bounty configured. Empty
      // pools and explicit zero rates also pay nothing, even if the other
      // field is omitted. Missing battle/side data remains unknown.
      if (rate == null && pool == null || rate === 0 || pool === 0) {
        best = Math.max(best ?? 0, 0);
        continue;
      }
      if (finite(rate) && rate >= 0 && finite(pool) && pool >= 0) {
        // The next 1k can only earn the remaining pool, even if it is smaller.
        const funded = Math.min(pool, rate * damage / 1000);
        best = Math.max(best ?? 0, funded);
      }
    }
    return best;
  }

  function baseSkill(skills, config, key) {
    const skill = globalThis.__weAgoDomain.skill(skills, key);
    if (finite(skill)) return skill;
    const value = skill?.value ?? globalThis.__weAgoDomain.skill(config?.skills, key)?.levels?.[skill?.level]?.value;
    return finite(value) && finite(skill?.prestige ?? 0) ? value + (skill.prestige ?? 0) : null;
  }

  function attackMultiplier(player, config, now = Date.now()) {
    const buffs = player?.buffs, attack = player?.skills?.attack;
    const boost = config?.items?.cocain?.flatStats?.percentAttack;
    if (buffs?.buffCodes?.includes("cocain") || buffs?.debuffCodes?.includes("cocain")) {
      const buffEnd = Date.parse(buffs.buffEndAt), debuffEnd = Date.parse(buffs.debuffEndAt);
      if (buffs.buffCodes?.includes("cocain") && !finite(buffEnd)
        || buffs.debuffCodes?.includes("cocain") && !finite(debuffEnd)) return null;
      if (now < buffEnd) return finite(boost) ? 1 + boost / 100 : null;
      // Some profiles only supply the buff end; derive the following debuff.
      const end = finite(debuffEnd) ? debuffEnd : buffEnd + config?.items?.cocain?.flatStats?.debuffDurationHours * 3600000;
      if (!finite(end)) return null;
      return now < end ? (finite(boost) ? 1 - boost / 100 : null) : 1;
    }
    if (finite(attack?.buffsPercent) && finite(attack?.debuffsPercent)) return 1 + (attack.buffsPercent - attack.debuffsPercent) / 100;
    return buffs === null || buffs && Array.isArray(buffs.buffCodes) && Array.isArray(buffs.debuffCodes) ? 1 : null;
  }

  function damageBonus(state) {
    for (const value of [state?.totalPercent, state?.damageBonusPercent, state?.damageBonusPercentage, state?.damageBonus?.percent]) if (finite(value) && value >= -100) return value;
    return finite(state?.damageMultiplier) && state.damageMultiplier >= 0 ? (state.damageMultiplier - 1) * 100 : null;
  }

  // Contracts are MU revenue, not a promise of a personal payout. Only the
  // current player's active MU contract is eligible; public auctions are not.
  function contractRate(contract, battleId, side, muId, now = Date.now(), damage = 1000) {
    if (contract === null) return 0;
    if (!contract || contract.battle !== battleId || (typeof contract.mu === "string" ? contract.mu : contract.mu?._id) !== muId) return null;
    if (typeof contract.status !== "string" || !["attacker", "defender"].includes(contract.forCountrySide)) return null;
    if (contract.status !== "active" || contract.forCountrySide !== side) return 0;
    if (contract.expiresAt && !finite(Date.parse(contract.expiresAt))) return null;
    if (contract.expiresAt && Date.parse(contract.expiresAt) <= now) return 0;
    const remaining = contract.minimumDamage - contract.currentDamages;
    const rate = contract.moneyPer1kDamages ?? contract.perK;
    if (![contract.minimumDamage, contract.currentDamages, rate].every(v => finite(v) && v >= 0)) return null;
    return rate * Math.min(damage, Math.max(0, remaining)) / 1000;
  }

  function contractApplies(contract, battleId, side, muId, now = Date.now()) {
    return Boolean(contract && contract.battle === battleId
      && (typeof contract.mu === "string" ? contract.mu : contract.mu?._id) === muId
      && contract.status === "active" && contract.forCountrySide === side
      && (!contract.expiresAt || !finite(Date.parse(contract.expiresAt)) || Date.parse(contract.expiresAt) > now));
  }

  function currentEstimate(s, side, now = Date.now()) {
    const ammo = s.equipment?.ammoQuantity === 0 ? "" : s.equipment?.ammo ?? "";
    const multiplier = attackMultiplier(s.player, s.config, now);
    const bonus = damageBonus(s.bonuses?.[side] ?? s.battle?.[side]);
    const baseDamage = ammo && !s.config?.items?.[ammo]?.flatStats ? null : calculateExpectedDamagePerHit(s.skills, s.gear, ammo ? s.config?.items?.[ammo]?.flatStats : null, false);
    const damage = finite(baseDamage) && finite(multiplier) && finite(bonus) ? baseDamage * multiplier * (1 + bonus / 100) : null;
    if (!(damage > 0)) return { damage: null, cost: null, bonus, boxes: null, elite: null, chance: null };
    const attempts = 1000 / damage;
    const loot = s.player?.skills?.lootChance?.total ?? baseSkill(s.player?.skills, s.config, "lootChance");
    const p = finite(loot) && loot >= 0 && loot <= 100 ? loot / 100 : null;
    const boxes = p === null ? null : p * attempts;
    const chance = p === null ? null : -Math.expm1(attempts * Math.log1p(-p)) * 100;
    const armor = baseSkill(s.player?.skills, s.config, "armor"), dodge = baseSkill(s.player?.skills, s.config, "dodge");
    const ac = s.config?.skills?.armor?.softCap, dc = s.config?.skills?.dodge?.softCap;
    const hp = s.player?.skills?.health?.total;
    const food = s.config?.items?.[s.foodCode ?? "cookedFish"]?.flatStats;
    const regen = finite(food?.healthRegenPercent) && finite(hp) ? hp * food.healthRegenPercent / 100 : food?.healthRegen;
    const ammoCost = ammo ? s.prices?.[ammo] : 0;
    let cost = null, consumableCost = null;
    if ([armor, dodge, ac, dc, regen, ammoCost, s.prices?.[s.foodCode ?? "cookedFish"], s.config?.battle?.healthCost].every(v => finite(v) && v >= 0)
      && ac > 0 && dc > 0 && regen > 0 && s.gear) {
      const hpPerHit = s.config.battle.healthCost * ac / (armor + (s.gear.armor ?? 0) + ac) * dc / (dodge + (s.gear.dodge ?? 0) + dc);
      const wear = equipmentWearPerHit(s);
      consumableCost = attempts * (ammoCost + hpPerHit / regen * s.prices[s.foodCode ?? "cookedFish"]);
      if (finite(wear)) cost = consumableCost + attempts * wear;
    }
    return { damage, cost, consumableCost, bonus, boxes, elite: boxes === null ? null : boxes / 100, chance };
  }

  function fullBurst(s, side, now = Date.now()) {
    const estimate = currentEstimate(s, side, now);
    const hp = s.player?.skills?.health?.total, hunger = s.player?.skills?.hunger?.total;
    const armor = baseSkill(s.player?.skills, s.config, "armor"), dodge = baseSkill(s.player?.skills, s.config, "dodge");
    const ac = s.config?.skills?.armor?.softCap, dc = s.config?.skills?.dodge?.softCap;
    const noFood = s.foodCode === "none";
    const foodPrice = noFood ? 0 : s.prices?.[s.foodCode ?? "cookedFish"];
    const food = s.config?.items?.[s.foodCode ?? "cookedFish"]?.flatStats;
    const regen = noFood ? 0 : finite(food?.healthRegenPercent) ? hp * food.healthRegenPercent / 100 : food?.healthRegen;
    if (![hp, hunger, armor, dodge, ac, dc, regen, s.config?.battle?.healthCost, estimate.damage].every(v => finite(v) && v >= 0)
      || !s.gear || hp <= 0 || ac <= 0 || dc <= 0 || s.config.battle.healthCost <= 0) return null;
    const hpPerHit = s.config.battle.healthCost * ac / (armor + (s.gear.armor ?? 0) + ac) * dc / (dodge + (s.gear.dodge ?? 0) + dc);
    const meals = noFood ? 0 : Math.floor(hunger), hits = (hp + meals * regen) / hpPerHit;
    const damage = hits * estimate.damage;
    const ammo = s.equipment?.ammoQuantity === 0 ? "" : s.equipment?.ammo ?? "";
    const ammoPrice = ammo ? s.prices?.[ammo] : 0;
    const wear = equipmentWearPerHit(s);
    const cost = [ammoPrice, foodPrice].every(v => finite(v) && v >= 0) && finite(wear) ? hits * (ammoPrice + wear) + meals * foodPrice : null;
    const consumableCost = [ammoPrice, foodPrice].every(v => finite(v) && v >= 0) ? hits * ammoPrice + meals * foodPrice : null;
    const loot = s.player?.skills?.lootChance?.total ?? baseSkill(s.player?.skills, s.config, "lootChance");
    const boxes = finite(loot) && loot >= 0 ? hits * loot / 100 : null;
    const elite = boxes === null ? null : boxes / 100;
    const value = (count, price) => count === 0 ? 0 : finite(count) && finite(price) && price >= 0 ? count * price : null;
    const boxValue = value(boxes, s.prices?.case1), eliteValue = value(elite, s.prices?.case2);
    return { damage, cost, consumableCost, hits, boxes, elite, boxValue, eliteValue };
  }

  // Price one remaining durability point, so partially used listings do not
  // look artificially cheaper than equivalent fresh equipment.
  function replacementUnitPrice(item, offers, tax, userId, scrapPrice = 0) {
    if (!finite(scrapPrice) || scrapPrice < 0 || !item || !gearCode(item.code) || !item.skills || !Array.isArray(offers) || !finite(tax) || tax < 0) return null;
    const required = Object.entries(item.skills).filter(([key]) => key !== "state");
    if (!required.length || required.some(([, value]) => !finite(value) || value < 0)) return null;
    let best = Infinity;
    for (const offer of offers) {
      const candidate = offer?.item;
      if (!candidate || candidate.code !== item.code || offer.user === userId || !finite(offer.price) || offer.price < 0
        || !finite(candidate.state) || candidate.state <= 0 || candidate.state > 100
        || !required.every(([key, value]) => {
          const stat = globalThis.__weAgoDomain.skill(candidate.skills, key);
          return finite(stat) && stat >= value;
        })) continue;
      best = Math.min(best, (offer.price * (1 + tax / 100) - breakScraps(item.code) * scrapPrice) / candidate.state);
    }
    return finite(best) ? best : null;
  }

  // Native item helper 22605 and rarity table 77622, verified 2026-10-25:
  // floor(baseScrap + bonusScrap * state/maxState); at breakage only base remains.
  function breakScraps(code) {
    const weaponTier = ["knife", "gun", "rifle", "sniper", "tank", "jet"].indexOf(code) + 1;
    const tier = weaponTier || Number(/^(?:helmet|chest|pants|gloves|boots)([1-6])$/.exec(code || "")?.[1]);
    return tier ? 2 * 3 ** (tier - 1) : null;
  }

  function equipmentWearPerHit(s) { return equipmentWear(s, 1); }
  function equipmentWear(s, hits, dodges) {
    if (!finite(hits) || hits < 0 || dodges !== undefined && (!finite(dodges) || dodges < 0 || dodges > hits)) return null;
    if (!s.equipment || !s.gear) return null;
    const equipped = SLOTS.filter(slot => s.equipment[slot] != null);
    if (!equipped.length) return 0;
    const dodge = baseSkill(s.player?.skills, s.config, "dodge"), cap = s.config?.skills?.dodge?.softCap;
    if (!finite(dodge) || dodge < 0 || !finite(cap) || cap <= 0) return null;
    const nonDodgedHits = dodges === undefined ? hits * cap / (dodge + (s.gear.dodge ?? 0) + cap) : hits - dodges;
    let cost = 0;
    for (const slot of equipped) {
      const price = s.equipmentPrices?.[slot];
      if (!finite(price)) return null;
      cost += price * (slot === "weapon" ? hits : nonDodgedHits);
    }
    return cost;
  }

  function owned(tag, name, text) {
    const node = document.createElement(tag);
    node.className = "we-ago-" + name;
    node.dataset.weAgo = "true";
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function write(node, text) { if (node.textContent !== text) node.textContent = text; }
  function numericText(node) {
    const text = node?.textContent?.trim().replace(/,/g, "");
    return text && /^\d+(?:\.\d+)?%?$/.test(text) ? Number(text.replace(/%$/, "")) : null;
  }
  function nativeStats(row) {
    const stats = {};
    for (const path of row.querySelectorAll("svg path[d]")) {
      const key = Object.keys(ICONS).find(key => path.getAttribute("d").startsWith(ICONS[key]));
      if (!key) continue;
      let parent = path.closest("svg").parentElement, value = null;
      for (let i = 0; parent && i < 3; i++, parent = parent.parentElement) {
        if (parent.querySelectorAll("svg").length !== 1) break;
        value = numericText(parent);
        if (value !== null) break;
      }
      if (value === null || Object.hasOwn(stats, key)) return null;
      stats[key] = value;
    }
    return stats;
  }
  function marketRows(config) {
    const result = new Map();
    const scope = document.getElementById("main-window") ?? document;
    for (const image of scope.querySelectorAll("img[alt]")) {
      const code = image.getAttribute("alt");
      if (!gearCode(code) || image.closest(OWNED) || !image.getClientRects().length) continue;
      let row = image.parentElement;
      for (let depth = 0; row && depth < 8; depth++, row = row.parentElement) {
        const buttons = [...row.querySelectorAll("button")].filter(b => !b.closest(OWNED));
        if (!buttons.length) continue;
        if (buttons.length !== 1 || !row.querySelector('a[href*="/user/"]')
          || [...row.querySelectorAll("img[alt]")].filter(img => gearCode(img.getAttribute("alt"))).length !== 1) break;
        const button = buttons[0];
        const priceRow = button.parentElement?.parentElement;
        const priceNode = priceRow?.firstElementChild;
        const price = priceNode && !priceNode.contains(button) ? numericText(priceNode) : null;
        const stats = nativeStats(row);
        const expected = config?.items?.[code]?.dynamicStats;
        const required = expected && Object.keys(expected).filter(key => ["attack", "precision", "criticalChance", "criticalDamages"].includes(key));
        if (stats && required && required.every(key => Object.hasOwn(stats, key === "criticalDamages" ? "criticalDamage" : key))) {
          result.set(row, { stats, price });
        }
        break;
      }
    }
    return result;
  }

  function nativeBattleBonuses() {
    // Fight controls live in the shared header, outside #main-window.
    const scope = document;
    const actionLabel = /^(defend|attack|move|defender|atacar|mover|défendre|attaquer|déplacer|verteidigen|angreifen|bewegen)$/i;
    const hasActionLabel = node => {
      // Native Move controls render the label and destination in separate
      // blocks. textContent concatenates these into e.g. "MoveLower Juba".
      // Read individual text nodes so the label remains distinct, including
      // when the control is disabled because the player cannot move yet.
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      let text;
      while ((text = walker.nextNode())) {
        if (!text.parentElement?.closest(OWNED) && actionLabel.test(text.textContent.trim())) return true;
      }
      return false;
    };
    const buttons = [...scope.querySelectorAll("button")].filter(node => !node.closest(OWNED) && node.getClientRects().length
      && (node.closest("#defender-hit-button, #attacker-hit-button")
        || hasActionLabel(node)
        || /\b(defend|attack|move|defender|atacar|mover|défendre|attaquer|déplacer|verteidigen|angreifen|bewegen)\b/i.test(node.textContent)));
    const percentage = node => /^(?:[+−-]\s*\d+(?:[.,]\d+)?|0(?:[.,]0+)?)\s*%$/.test(node.textContent.trim());
    const percentagesIn = parent => [...parent.querySelectorAll("*")].filter(node => !node.closest(OWNED) && node.getClientRects().length
      && percentage(node) && ![...node.children].some(percentage));
    const read = node => Number(node.textContent.trim().replace(/\s|%/g, "").replace("−", "-").replace(",", "."));
    const quotes = [];
    for (const button of buttons) {
      let parent = button.parentElement;
      for (let depth = 0; parent && depth < 7; depth++, parent = parent.parentElement) {
        if (buttons.filter(node => parent.contains(node)).length !== 1) break;
        const percentages = percentagesIn(parent);
        if (percentages.length > 1) break;
        if (percentages.length === 1) {
          const percent = read(percentages[0]);
          if (finite(percent) && percent >= -100) quotes.push({ button, percent });
          break;
        }
      }
    }
    if (quotes.length !== 2 && buttons.length === 2) {
      let parent = buttons[0].parentElement;
      while (parent && !parent.contains(buttons[1])) parent = parent.parentElement;
      for (let depth = 0; parent && depth < 4; depth++, parent = parent.parentElement) {
        const percentages = percentagesIn(parent);
        if (percentages.length > 2) break;
        if (percentages.length === 2 && percentages[0].getBoundingClientRect().left < percentages[1].getBoundingClientRect().left) {
          quotes.length = 0;
          percentages.forEach((node, index) => quotes.push({ button: buttons[index], percent: read(node) }));
          break;
        }
        if (parent === scope) break;
      }
    }
    if (quotes.length !== 2 || quotes[0].button === quotes[1].button || quotes.some(quote => !finite(quote.percent) || quote.percent < -100)) return {};
    // WarEra's native fight columns follow defender then attacker. Require
    // their visual ordering to agree with DOM ordering before assigning sides.
    if (quotes[0].button.getBoundingClientRect().left >= quotes[1].button.getBoundingClientRect().left) return {};
    return { defender: { totalPercent: quotes[0].percent }, attacker: { totalPercent: quotes[1].percent } };
  }

  function create(kind, burst = false) {
    const badges = new Map();
    let cachedRows = new Map();
    let stopped = false, generation = 0, routeKey = "", pending = false, nextFetch = 0, snapshot, panel, values;
    let stopObservation, refreshRequested = false, loadoutRevision = 0, lastForcedAt = -Infinity;
    let nativeBonuses = {}, signatures = new Map();
    let issue = "", foodCode = "cookedFish", foodEdited = false;
    if (burst) void chrome.storage?.local?.get("we-ago:combat-food").then(saved => {
      if (stopped || foodEdited) return;
      if (["none", "cookedFish", "bread", "steak"].includes(saved?.["we-ago:combat-food"])) foodCode = saved["we-ago:combat-food"];
      if (values?.food) values.food.value = foodCode;
      render(false);
    }).catch(() => {});
    function clear() {
      for (const badge of badges.values()) badge.remove();
      badges.clear();
      cachedRows.clear();
      panel?.remove(); panel = values = undefined;
    }
    function info() {
      const url = new URL(location.href);
      if (kind === "market" && /^\/market\/equipments\/?$/.test(url.pathname)) return { key: url.href };
      const match = /^\/battle\/([a-f\d]{24})\/?$/i.exec(url.pathname);
      // Historical rounds cannot have a current bounty ROI.
      return kind === "battle" && match && !url.searchParams.has("round") ? { key: url.href, battleId: match[1] } : null;
    }
    function mountBattle() {
      const defender = document.getElementById("defender-round-bar"), attacker = document.getElementById("attacker-round-bar");
      let anchor = defender?.parentElement;
      while (anchor && !anchor.contains(attacker)) anchor = anchor.parentElement;
      if (!anchor || anchor === document.body || anchor === document.documentElement || anchor.parentElement === document.body) { clear(); return; }
      if (!panel) {
        panel = owned("div", "pill-roi");
        if (burst) panel.classList.add("we-ago-full-burst");
        panel.title = t("Expected values per 1k damage with equipped gear. Costs include food, ammo and equipment wear at sampled replacement market prices including tax. Excludes already-used pills and free regeneration; Breakage scrap value is amortized over durability, not counted as immediate cash. MU contract revenue is separate from personal net. Prices, pools and contract progress can change.");
        if (burst) panel.title = t("Expected burst from 100% HP and hunger, using current gear and effects. Includes food, ammo and equipment wear; starting HP is free. Equipment wear uses the lowest taxed price per durability point among up to 36 same-type offers with equal or better stats. Weapons wear every hit; other gear only on non-dodged hits. Assumes equivalent replacements and unchanged effects; excludes regeneration. Breakage scrap value is amortized over durability, not counted as immediate cash. An active MU contract replaces bounty in the net estimate.");
        const scopeLabel = burst ? t("Full burst · 100% HP + hunger") : t("Average damage");
        if (!burst) panel.title = t("Average damage per hit");
        const table = owned("table", "combat-table");
        table.setAttribute("aria-label", scopeLabel);
        const body = owned("tbody", "combat-body");
        const status = owned("p", "combat-status"); status.setAttribute("role", "status");
        values = { status };
        for (const [metric, name] of (burst ? [["damage", "Total damage"], ["bounty", "Bounty won"], ["contract", "MU contract"], ["boxes", "Box value"], ["elite", "Elite box value"], ["cost", "Total cost"], ["net", "Personal net"]] : [["damage", "Dmg / hit"]])) {
          const row = owned("tr", "combat-row"), heading = owned("th", "combat-metric", t(name));
          heading.dataset.icon = ({damage:"⚔",cost:"🪙",bounty:"🏅",contract:"🛡",net:"±",boxes:"📦",elite:"🎁"})[metric];
          heading.scope = "row"; values[metric] = {};
          values[metric + "Heading"] = heading;
          for (const side of ["defender", "attacker"]) {
            const cell = owned("td", "combat-profit"); cell.dataset.side = side; cell.dataset.metric = metric;
            cell.setAttribute("aria-label", t(side) + ": " + t(name)); values[metric][side] = cell;
          }
          row.append(values[metric].defender, heading, values[metric].attacker); body.append(row);
        }
        table.append(body);
        if (burst) {
          const controls = owned("div", "combat-controls");
          const label = owned("label", "combat-label", "🍽 ");
          const select = owned("select", "combat-food");
          select.setAttribute("aria-label", t("Food"));
          for (const [code, name] of [["none", "No food"], ["cookedFish", "Cooked fish"], ["bread", "Bread"], ["steak", "Steak"]]) {
            const option = owned("option", "combat-option", t(name)); option.value = code; select.append(option);
          }
          select.value = foodCode;
          select.addEventListener("change", () => {
            foodEdited = true; foodCode = select.value;
            void chrome.storage?.local?.set({ "we-ago:combat-food": foodCode });
            render(false);
          });
          values.food = select;
          label.append(select); controls.append(owned("span", "combat-scope", scopeLabel), label);
          panel.append(controls);
        }
        panel.append(table, status);
      }
      // Share the header with the independent battle-resource module without
      // repeatedly competing for the same next-sibling position.
      if (anchor.nextElementSibling?.matches(".we-ago-battle-panel")) anchor = anchor.nextElementSibling;
      if (burst && anchor.nextElementSibling?.matches(".we-ago-pill-roi:not(.we-ago-full-burst)")) anchor = anchor.nextElementSibling;
      if (panel.previousElementSibling !== anchor) anchor.insertAdjacentElement("afterend", panel);
    }
    function render(discover = true) {
      if (stopped || document.hidden || info()?.key !== routeKey) return;
      const available = Boolean(snapshot);
      if (kind === "market") {
        const rows = discover ? (cachedRows = marketRows(snapshot?.config)) : cachedRows;
        for (const [row, badge] of badges) if (!rows.has(row) || !available || !row.isConnected) { badge.remove(); badges.delete(row); }
        if (!available) return;
        const base = calculateExpectedDamagePerHit(snapshot.skills, {}, null, false);
        let best = Infinity;
        const rendered = [];
        for (const [row, model] of rows) {
          if (!row.isConnected) continue;
          const damage = calculateExpectedDamagePerHit(snapshot.skills, model.stats, null, false);
          const gain = finite(base) && finite(damage) ? damage - base : null;
          const value = gain > 0 && finite(model.price) ? model.price / gain * 10 : null;
          let badge = badges.get(row);
          if (!badge) { badge = owned("div", "cped-badge"); badges.set(row, badge); }
          badge.title = t("This item alone versus bare base skills; no pill or ammo. Uses the displayed taxed purchase price. Price per +10 Dmg is purchase price divided by marginal damage × 10; no equipment lifetime assumed.");
          if (!badge.firstChild) {
            badge.append(owned("span", "cped-damage"), owned("span", "cped-price"));
          }
          write(badge.firstChild, t`Expected Dmg/hit ${fmt(damage)}`);
          globalThis.__weAgoUi.money(badge.lastChild, fmt(value), t(" / +10 Dmg"));
          // The native card is a flex row; keep the badge in its content column.
          const host = row.lastElementChild?.dataset.weAgo === "true" ? row : row.lastElementChild;
          if (!badge.isConnected) (host ?? row).append(badge);
          if (finite(value)) best = Math.min(best, value);
          rendered.push({ badge, value });
        }
        for (const { badge, value } of rendered) badge.classList.toggle("we-ago-cped-best", finite(value) && value === best);
        return;
      }
      if (discover || !panel?.isConnected) mountBattle();
      if (!panel) return;
      const s = snapshot && { ...snapshot, foodCode };
      if (!burst) {
        for (const side of ["defender", "attacker"]) {
          const estimate = s && currentEstimate({ ...s, bonuses: nativeBonuses }, side);
          write(values.damage[side], fmt(estimate?.damage));
        }
        write(values.status, issue || (pending ? t("Loading…") : ""));
        return;
      }
      const gearKnown = s && finite(equipmentWearPerHit(s));
      write(values.netHeading, gearKnown ? t(burst ? "Personal net" : "Personal net / 1k") : t(burst ? "Net before gear" : "Net before gear / 1k"));
      if (burst) {
        write(values.costHeading, gearKnown ? t("Total cost") : t("Food + ammo"));
        let missing = false, missingBoxPrice = false;
        for (const side of ["defender", "attacker"]) {
          const result = s && fullBurst({ ...s, bonuses: nativeBonuses }, side);
          const nativeContract = s?.muId ? globalThis.__weAgoContracts?.get(info().battleId, s.muId) : null;
          const useContract = contractApplies(nativeContract, info().battleId, side, s?.muId);
          const bounty = result && (useContract ? 0 : bountyRate(info().battleId, side, s.battle, [], Date.now(), result.damage));
          const contract = result && contractRate(nativeContract, info().battleId, side, s.muId, Date.now(), result.damage);
          const shownCost = result?.cost ?? result?.consumableCost;
          const revenue = useContract ? contract : bounty;
          const net = [revenue, shownCost, result?.boxValue, result?.eliteValue].every(finite) ? revenue + result.boxValue + result.eliteValue - shownCost : null;
          missingBoxPrice ||= Boolean(result) && (!finite(result.boxValue) || !finite(result.eliteValue));
          write(values.damage[side], fmt(result?.damage));
          for (const metric of ["boxes", "elite"]) {
            globalThis.__weAgoUi.money(values[metric][side], fmt(result?.[metric === "boxes" ? "boxValue" : "eliteValue"]));
            values[metric][side].title = t("Expected drops × market price. Estimated value, not guaranteed sale proceeds.");
          }
          for (const [key, value] of [["cost", shownCost], ["bounty", bounty], ["contract", contract], ["net", net]]) {
            globalThis.__weAgoUi.money(values[key][side], finite(value) && key === "net" ? (value < 0 ? "−" : "+") + fmt(Math.abs(value)) : fmt(value), key === "net" && value < 0 ? t(" LOSS") : "");
          }
          values.net[side].classList.toggle("we-ago-combat-loss", finite(net) && net < 0);
          values.net[side].classList.toggle("we-ago-combat-gain", finite(net) && net >= 0);
          missing ||= !result;
        }
        const contractIssue = s?.muId && globalThis.__weAgoContracts?.get(info().battleId, s.muId) === undefined ? t("Waiting for the game's contract response") : "";
        write(values.status, issue || (pending ? t("Loading costs and bounty…") : missing ? t("Full-burst stats unavailable.") : s?.priceIssue || (missingBoxPrice ? t("Box market prices unavailable.") : s?.waiting?.equipmentPrices ? t("Loading equipment prices…") : [gearKnown ? s?.equipmentPriceNote : "", s?.rewardIssue, contractIssue].filter(Boolean).join(" · "))));
        return;
      }
    }
    async function load(current, forceRefresh = false) {
      const equipmentRevision = loadoutRevision;
      const revision = ++generation;
      const valid = () => !stopped && !document.hidden && generation === revision && info()?.key === current.key && equipmentRevision === loadoutRevision;
      pending = true; nextFetch = Date.now() + 60000;
      issue = ""; render(false);
      const expiries = [], data = { waiting: {} };
      async function query(procedure, input = {}, ttlSeconds = 120) {
        if (!valid()) throw new Error("Detached");
        const response = await (globalThis.__weAgoApi?.send ?? chrome.runtime.sendMessage)({ type: "WE_AGO_QUERY", procedure, input, options: { ttlSeconds } });
        if (!response?.ok) throw Object.assign(new Error(t("Read unavailable")), response?.error);
        if (!finite(response.data?.expiresAt)) throw new Error(t("Read unavailable"));
        expiries.push(response.data.expiresAt);
        return unwrap(response.data.data);
      }
      let ready = false;
      const errors = new Map();
      function publish() {
        if (!ready || !valid()) return;
        data.rewardIssue = [...errors.values()].join(" · ");
        const expiresAt = Math.min(Date.now() + 120000, ...expiries);
        if (!finite(expiresAt)) return;
        snapshot = { ...data, expiresAt };
        nextFetch = Math.max(Date.now() + 10000, expiresAt);
        render(false);
      }
      function optional(key, task, scope) {
        data.waiting[key] = true;
        return task.then(value => {
          if (valid()) { data.waiting[key] = false; data[key] = value; publish(); }
        }, error => {
          if (!valid()) return;
          data.waiting[key] = false;
          const message = globalThis.__weAgoUi.readError(error, t(scope));
          if (key === "prices" || key === "equipmentPrices") data.priceIssue = message;
          else errors.set(key, message);
          publish();
        });
      }
      try {
        const response = await (globalThis.__weAgoApi?.send ?? chrome.runtime.sendMessage)({ type: "WE_AGO_PLAYER_SUMMARY", includeEquipment: kind === "battle", ...(forceRefresh ? { forceRefresh: true } : {}) });
        if (!valid()) return;
        const summary = response?.ok && response.data;
        if (summary?.state === "setup") throw Object.assign(new Error(t("Player setup required")), { code: "PLAYER_SETUP" });
        if (summary?.state !== "ready" || !summary.profile?.ok) throw Object.assign(new Error(t("Player unavailable")), response?.error || summary?.profile?.error);
        const player = unwrap(summary.profile.result.data);
        if (player?._id !== summary.userId) throw new Error("Player identity mismatch");
        data.player = player;
        expiries.push(summary.profile.result.expiresAt);
        if (kind === "battle") {
          if (!summary.equipment?.ok) throw Object.assign(new Error("Equipment unavailable"), summary.equipment?.error);
          data.equipment = unwrap(summary.equipment.result.data);
          data.gear = equipmentSkills(data.equipment);
          expiries.push(summary.equipment.result.expiresAt);
          data.muId = typeof player.mu === "string" ? player.mu : player.mu?._id;
        }
        async function readEquipmentPrices() {
          const slots = SLOTS.filter(slot => data.equipment?.[slot] != null);
          if (!slots.length) return {};
          const countryId = typeof player.country === "string" ? player.country : player.country?._id;
          if (!countryId) throw new Error("Country unavailable");
          const scrapPrices = await query("itemTrading.getPrices");
          const scrapPrice = scrapPrices?.scraps;
          if (!finite(scrapPrice) || scrapPrice < 0) throw new Error("Scrap market price unavailable");
          const country = await query("country.getCountryById", { countryId }, 600);
          const tax = country?.taxes?.market;
          if (!finite(tax) || tax < 0) throw new Error("Market tax unavailable");
          const quotes = await Promise.all(slots.map(async slot => {
            const item = data.equipment[slot];
            if (!gearCode(item?.code) || !item.skills) throw new Error("Equipment unavailable");
            const minSkills = Object.fromEntries(Object.entries(item.skills).filter(([key]) => key !== "state"));
            const offers = [], cursors = new Set();
            let cursor, price = null;
            try {
              for (let page = 0; page < 3; page++) {
                const result = await query("itemOffer.getItemOffers", { itemCode: item.code, minSkills, limit: 12, ...(cursor ? { cursor } : {}) });
                if (!Array.isArray(result?.items)) throw new Error("Equipment offers unavailable");
                offers.push(...result.items);
                cursor = result.nextCursor;
                if (!cursor || cursors.has(cursor)) break;
                if (typeof cursor !== "string") throw new Error("Invalid offer cursor");
                cursors.add(cursor);
              }
              price = replacementUnitPrice(item, offers, tax, player._id, scrapPrice);
            } catch (error) {
              if (!valid()) throw error;
              // Some game-session listing reads reject API tokens. Fall back
              // to the market benchmark used by the native equipment UI.
            }
            if (!finite(price)) {
              const average = await query("gameStat.getEquipmentAvgByCode", { itemCode: item.code });
              if (!finite(average) || average <= 0) throw new Error("No equipment market price");
              price = (average * (1 + tax / 100) - breakScraps(item.code) * scrapPrice) / 100;
              data.equipmentPriceNote = t("Gear cost uses market averages.");
            }
            return [slot, price];
          }));
          return Object.fromEntries(quotes);
        }
        const configTask = query("gameConfig.getGameConfig", {}, 600);
        const tasks = burst ? [optional("prices", query("itemTrading.getPrices"), "Prices")] : [];
        if (kind === "battle" && burst) tasks.push(
          optional("equipmentPrices", readEquipmentPrices(), "Equipment prices"),
          optional("battle", query("battle.getById", { battleId: current.battleId }), "Bounty"));
        const config = await configTask;
        if (!valid()) return;
        data.config = config;
        data.skills = { ...player.skills, militaryRankPercent: player.skills?.attack?.militaryRankPercent,
          precisionOverflowValue: config?.skills?.precision?.skillOverflowValue,
          criticalOverflowValue: config?.skills?.criticalChance?.skillOverflowValue,
          pillPercentAttack: config?.items?.cocain?.flatStats?.percentAttack };
        for (const key of ["attack", "precision", "criticalChance", "criticalDamage"]) data.skills[key] = baseSkill(player.skills, config, key);
        ready = true;
        // A slow price request must not hide known damage,
        // loot, costs or bounty. Later outcomes fill only their own fields.
        pending = false;
        publish();
        await Promise.all(tasks);
      } catch (error) {
        if (valid()) issue = globalThis.__weAgoUi.readError(error, t("Combat data"));
      } finally {
        if (!stopped && generation === revision) {
          pending = false;
          if (document.hidden) nextFetch = 0;
          if (!document.hidden && info()?.key === current.key) { render(); if (refreshRequested) sync({ discover: false }); }
        }
      }
    }
    function observeLoadout(event) {
      if (stopped || event.source !== window || event.origin !== location.origin || event.data?.channel !== "we-ago-combat-read-v1" || !info()) return;
      const record = event.data.record;
      if (record?.kind !== "loadout" || !finite(record.receivedAt) || record.receivedAt > Date.now() || Date.now() - record.receivedAt >= 60000
        || record.userId && record.userId !== snapshot?.player?._id || typeof record.procedure !== "string") return;
      if (typeof record.signature === "string") {
        if (signatures.get(record.procedure) === record.signature) return;
        signatures.set(record.procedure, record.signature);
      }
      refreshRequested = true; loadoutRevision++;
      // Hide stale loadout-derived quotes while the current loadout is read.
      if (snapshot) snapshot = { ...snapshot, gear: null };
      sync({ discover: false });
    }
    function watchLoadout() {
      if (stopObservation || kind !== "battle") return;
      window.addEventListener("message", observeLoadout);
      window.postMessage({ channel: "we-ago-combat-read-v1", subscribe: true }, location.origin);
      stopObservation = () => {
        window.removeEventListener("message", observeLoadout);
        window.postMessage({ channel: "we-ago-combat-read-v1", subscribe: false }, location.origin);
        stopObservation = undefined;
      };
    }
    function sync({ discover = true } = {}) {
      if (stopped) return;
      const current = info(), key = current?.key ?? "";
      if (key !== routeKey) {
        generation++; clear(); stopObservation?.(); signatures.clear(); nativeBonuses = {};
        snapshot = undefined; pending = false; nextFetch = 0; issue = ""; routeKey = key;
        refreshRequested = false; loadoutRevision++;
      }
      if (!current) return;
      watchLoadout();
      if (kind === "battle" && discover && !document.hidden) nativeBonuses = nativeBattleBonuses();
      render(discover);
      const force = refreshRequested && Date.now() - lastForcedAt >= 1000;
      if (!document.hidden && !pending && (force || Date.now() >= nextFetch)) {
        if (force) { refreshRequested = false; lastForcedAt = Date.now(); }
        void load(current, force || kind === "battle" && !snapshot);
      }
    }
    return {
      sync,
      tick() { sync({ discover: false }); },
      destroy() { stopped = true; generation++; stopObservation?.(); signatures.clear(); refreshRequested = false; snapshot = undefined; clear(); }
    };
  }
  globalThis.__weAgoCombatMath = { calculateExpectedDamagePerHit, equipmentSkills, sequenceCosts, bountyRate, nativeStats, marketRows, baseSkill, attackMultiplier, damageBonus, contractRate, contractApplies, currentEstimate, fullBurst, replacementUnitPrice, breakScraps, equipmentWear, equipmentWearPerHit, nativeBattleBonuses };
  globalThis.__weAgoEquipmentCped = { create: () => create("market") };
  globalThis.__weAgoFullBurst = { create: () => create("battle", true) };
  globalThis.__weAgoPillRoi = { create: () => create("battle") };
})();
