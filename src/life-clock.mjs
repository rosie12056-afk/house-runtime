const OPPORTUNITY_TYPES = new Set(["tick", "journal", "dream", "handoff"]);
const LIFE_STATES = new Set(["awake", "sleeping"]);

function minutes(value, name) {
  if (typeof value !== "string" || !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(value)) throw new Error(`${name} must use HH:MM`);
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function localParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
  return values;
}

function shiftDate({ year, month, day }, offset) {
  const date = new Date(Date.UTC(year, month - 1, day + offset));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function zonedTimeToUtc(local, timeZone) {
  let candidate = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, 0, 0);
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const observed = localParts(new Date(candidate), timeZone);
    const observedAsUtc = Date.UTC(observed.year, observed.month - 1, observed.day, observed.hour, observed.minute, observed.second || 0, 0);
    const targetAsUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, 0, 0);
    const correction = targetAsUtc - observedAsUtc;
    candidate += correction;
    if (correction === 0) break;
  }
  const confirmed = localParts(new Date(candidate), timeZone);
  if (confirmed.year !== local.year || confirmed.month !== local.month || confirmed.day !== local.day || confirmed.hour !== local.hour || confirmed.minute !== local.minute) {
    throw new Error(`local time does not exist in ${timeZone}`);
  }
  return new Date(candidate);
}

export class LifeClock {
  constructor(config) {
    if (!config || typeof config !== "object") throw new Error("lifeClock config is required");
    if (typeof config.schedule_id !== "string" || !config.schedule_id.includes(":")) throw new Error("schedule_id must be a namespaced identifier");
    try {
      new Intl.DateTimeFormat("en", { timeZone: config.time_zone }).format(new Date());
    } catch {
      throw new Error("time_zone must be a valid IANA timezone");
    }
    if (!config.sleep_window || typeof config.sleep_window !== "object") throw new Error("sleep_window is required");
    this.sleepStart = minutes(config.sleep_window.start, "sleep_window.start");
    this.sleepEnd = minutes(config.sleep_window.end, "sleep_window.end");
    if (this.sleepStart === this.sleepEnd) throw new Error("sleep window cannot cover zero or twenty-four hours");
    if (!Array.isArray(config.opportunities)) throw new Error("opportunities must be an array");
    this.rules = config.opportunities.map((rule) => {
      if (typeof rule.rule_id !== "string" || !rule.rule_id.includes(":")) throw new Error("opportunity rule_id must be namespaced");
      if (!OPPORTUNITY_TYPES.has(rule.opportunity_type)) throw new Error(`unsupported opportunity type: ${rule.opportunity_type}`);
      const atMinutes = minutes(rule.at, `opportunity ${rule.rule_id} at`);
      if (!Number.isInteger(rule.window_minutes) || rule.window_minutes < 1 || rule.window_minutes > 1440) throw new Error("window_minutes must be between 1 and 1440");
      if (!new Set(["skip", "offer_on_resume"]).has(rule.miss_policy)) throw new Error("miss_policy must be skip or offer_on_resume");
      if (rule.miss_policy === "offer_on_resume" && (!Number.isInteger(rule.catch_up_minutes) || rule.catch_up_minutes < 1 || rule.catch_up_minutes > 1440)) {
        throw new Error("offer_on_resume requires catch_up_minutes between 1 and 1440");
      }
      if (rule.miss_policy === "skip" && rule.catch_up_minutes != null) throw new Error("skip rules cannot define catch_up_minutes");
      if (!Array.isArray(rule.allowed_states) || !rule.allowed_states.length || rule.allowed_states.some((state) => !LIFE_STATES.has(state))) {
        throw new Error("allowed_states must explicitly contain awake and/or sleeping");
      }
      if (!Number.isInteger(rule.max_attempts) || rule.max_attempts < 1 || rule.max_attempts > 10) throw new Error("max_attempts must be between 1 and 10");
      if (!Number.isInteger(rule.retry_delay_minutes) || rule.retry_delay_minutes < 1 || rule.retry_delay_minutes > 1440) throw new Error("retry_delay_minutes must be between 1 and 1440");
      return { ...structuredClone(rule), atMinutes };
    });
    this.scheduleId = config.schedule_id;
    this.timeZone = config.time_zone;
  }

  stateAt(value) {
    const date = value instanceof Date ? value : new Date(value);
    const local = localParts(date, this.timeZone);
    const current = local.hour * 60 + local.minute;
    const sleeping = this.sleepStart < this.sleepEnd
      ? current >= this.sleepStart && current < this.sleepEnd
      : current >= this.sleepStart || current < this.sleepEnd;
    return sleeping ? "sleeping" : "awake";
  }

  dueWindows(value) {
    const now = value instanceof Date ? value : new Date(value);
    const local = localParts(now, this.timeZone);
    const windows = [];
    for (const rule of this.rules) {
      for (const offset of [0, -1]) {
        const day = shiftDate(local, offset);
        const start = zonedTimeToUtc({ ...day, hour: Math.floor(rule.atMinutes / 60), minute: rule.atMinutes % 60 }, this.timeZone);
        const scheduledEnd = new Date(start.getTime() + rule.window_minutes * 60000);
        const end = new Date(scheduledEnd.getTime() + (rule.miss_policy === "offer_on_resume" ? rule.catch_up_minutes * 60000 : 0));
        if (now >= start && now < end) windows.push({ rule: structuredClone(rule), start, end, catchUp: now >= scheduledEnd });
      }
    }
    return windows;
  }
}
