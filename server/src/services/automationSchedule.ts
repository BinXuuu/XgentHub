// 定时任务的时间规则：沿用 Codex 自动化的 RRULE 写法（FREQ=HOURLY;INTERVAL=6、FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=9;BYMINUTE=0），
// 只支持界面上能设的这几种：每 N 小时、每 N 天的某个时刻、每周某几天的某个时刻。时间按本机时区算。

export type RruleFreq = "HOURLY" | "DAILY" | "WEEKLY";
export const WEEKDAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const; // 下标就是 Date#getDay()
export type WeekdayCode = (typeof WEEKDAY_CODES)[number];

export interface ParsedRrule {
  freq: RruleFreq;
  interval: number;
  byHour: number | null;
  byMinute: number | null;
  byDay: WeekdayCode[];
}

const WEEKDAY_LABEL: Record<WeekdayCode, string> = { MO: "一", TU: "二", WE: "三", TH: "四", FR: "五", SA: "六", SU: "日" };
const HOUR_MS = 60 * 60 * 1000;

function intField(raw: string | undefined, name: string, min: number, max: number): number | null {
  if (raw === undefined || raw === "") return null;
  if (!/^\d+$/.test(raw)) throw new Error(`时间规则里 ${name} 不是整数：${raw}`);
  const value = Number(raw);
  if (value < min || value > max) throw new Error(`时间规则里 ${name} 要在 ${min}–${max} 之间`);
  return value;
}

export function parseRrule(rrule: string): ParsedRrule {
  const fields = new Map<string, string>();
  for (const part of rrule.replace(/^RRULE:/i, "").split(";")) {
    if (!part.trim()) continue;
    const [key, value = ""] = part.split("=");
    fields.set(key!.trim().toUpperCase(), value.trim().toUpperCase());
  }
  const freq = fields.get("FREQ");
  if (freq !== "HOURLY" && freq !== "DAILY" && freq !== "WEEKLY") throw new Error("时间规则只支持每小时、每天、每周（FREQ=HOURLY / DAILY / WEEKLY）");
  const byDay = (fields.get("BYDAY") ?? "")
    .split(",")
    .map((day) => day.trim())
    .filter(Boolean);
  for (const day of byDay) if (!(WEEKDAY_CODES as readonly string[]).includes(day)) throw new Error(`时间规则里的星期写错了：${day}`);
  return {
    freq,
    interval: intField(fields.get("INTERVAL"), "INTERVAL", 1, freq === "HOURLY" ? 24 * 30 : 365) ?? 1,
    byHour: intField(fields.get("BYHOUR"), "BYHOUR", 0, 23),
    byMinute: intField(fields.get("BYMINUTE"), "BYMINUTE", 0, 59),
    byDay: [...new Set(byDay)].sort((a, b) => WEEKDAY_CODES.indexOf(a as WeekdayCode) - WEEKDAY_CODES.indexOf(b as WeekdayCode)) as WeekdayCode[],
  };
}

/** 严格晚于 after 的下一次运行时间。到点执行完以后用「当前时间」再算一次，所以没开机错过的几次不会挨个补跑。 */
export function nextRunAfter(rrule: string, after: Date): Date {
  const rule = parseRrule(rrule);
  if (rule.freq === "HOURLY") {
    const next = new Date(after.getTime() + rule.interval * HOUR_MS);
    if (rule.byMinute === null) next.setSeconds(0, 0);
    else next.setMinutes(rule.byMinute, 0, 0);
    while (next.getTime() <= after.getTime()) next.setTime(next.getTime() + HOUR_MS);
    return next;
  }
  const hour = rule.byHour ?? 9;
  const minute = rule.byMinute ?? 0;
  if (rule.freq === "DAILY") {
    const next = new Date(after);
    next.setHours(hour, minute, 0, 0);
    if (next.getTime() <= after.getTime()) next.setDate(next.getDate() + rule.interval);
    return next;
  }
  const days = rule.byDay.length ? rule.byDay : [WEEKDAY_CODES[after.getDay()]!];
  for (let offset = 0; offset <= 7; offset++) {
    const next = new Date(after);
    next.setDate(after.getDate() + offset);
    next.setHours(hour, minute, 0, 0);
    if (next.getTime() > after.getTime() && days.includes(WEEKDAY_CODES[next.getDay()]!)) return next;
  }
  throw new Error("算不出下一次运行时间");
}

const pad = (value: number) => String(value).padStart(2, "0");

/** 给人看的说明：「每 6 小时」「每天 09:00」「工作日 09:30」「每周一、三 20:00」。 */
export function describeRrule(rrule: string): string {
  const rule = parseRrule(rrule);
  if (rule.freq === "HOURLY") {
    const base = rule.interval === 1 ? "每小时" : `每 ${rule.interval} 小时`;
    return rule.byMinute === null ? base : `${base}（第 ${rule.byMinute} 分）`;
  }
  const time = `${pad(rule.byHour ?? 9)}:${pad(rule.byMinute ?? 0)}`;
  if (rule.freq === "DAILY") return rule.interval === 1 ? `每天 ${time}` : `每 ${rule.interval} 天 ${time}`;
  const days = rule.byDay;
  if (days.join(",") === "MO,TU,WE,TH,FR") return `工作日 ${time}`;
  if (days.length === 7) return `每天 ${time}`;
  const ordered = [...days].sort((a, b) => ((WEEKDAY_CODES.indexOf(a) + 6) % 7) - ((WEEKDAY_CODES.indexOf(b) + 6) % 7));
  return `每周${ordered.map((day) => WEEKDAY_LABEL[day]).join("、") || "?"} ${time}`;
}
