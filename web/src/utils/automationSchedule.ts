// 定时任务表单里的「运行时间」和 RRULE 字符串互转（服务端测试直接导入这个文件）。规则格式和 Codex 自动化一样。

export type ScheduleMode = "hourly" | "daily" | "weekdays" | "weekly";
export const WEEKDAYS = [
  { code: "MO", label: "一" },
  { code: "TU", label: "二" },
  { code: "WE", label: "三" },
  { code: "TH", label: "四" },
  { code: "FR", label: "五" },
  { code: "SA", label: "六" },
  { code: "SU", label: "日" },
] as const;
export type WeekdayCode = (typeof WEEKDAYS)[number]["code"];

export interface ScheduleForm {
  mode: ScheduleMode;
  /** 每隔几小时（hourly）。 */
  intervalHours: number;
  /** hourly 时在第几分钟跑。 */
  minute: number;
  /** daily / weekdays / weekly 的时刻，HH:mm。 */
  time: string;
  /** weekly 选的星期。 */
  days: WeekdayCode[];
}

export const DEFAULT_SCHEDULE: ScheduleForm = { mode: "daily", intervalHours: 6, minute: 0, time: "09:00", days: ["MO"] };
const WEEKDAY_SET = "MO,TU,WE,TH,FR";

function splitTime(time: string): [number, number] {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) throw new Error("时间格式应为 HH:mm");
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error("时间超出范围");
  return [hour, minute];
}

export function buildRrule(form: ScheduleForm): string {
  if (form.mode === "hourly") {
    const interval = Math.round(form.intervalHours);
    if (!Number.isFinite(interval) || interval < 1 || interval > 720) throw new Error("间隔要在 1–720 小时之间");
    const minute = Math.round(form.minute);
    if (!Number.isFinite(minute) || minute < 0 || minute > 59) throw new Error("分钟要在 0–59 之间");
    return `FREQ=HOURLY;INTERVAL=${interval};BYMINUTE=${minute}`;
  }
  const [hour, minute] = splitTime(form.time);
  if (form.mode === "daily") return `FREQ=DAILY;BYHOUR=${hour};BYMINUTE=${minute}`;
  if (form.mode === "weekdays") return `FREQ=WEEKLY;BYDAY=${WEEKDAY_SET};BYHOUR=${hour};BYMINUTE=${minute}`;
  const days = WEEKDAYS.map((day) => day.code).filter((code) => form.days.includes(code));
  if (days.length === 0) throw new Error("至少选一天");
  return `FREQ=WEEKLY;BYDAY=${days.join(",")};BYHOUR=${hour};BYMINUTE=${minute}`;
}

/** 编辑已有定时任务时把规则还原成表单；认不出来的规则回到默认值。 */
export function formFromRrule(rrule: string): ScheduleForm {
  const fields = new Map(
    rrule
      .replace(/^RRULE:/i, "")
      .split(";")
      .filter(Boolean)
      .map((part) => {
        const [key, value = ""] = part.split("=");
        return [key!.trim().toUpperCase(), value.trim().toUpperCase()] as const;
      })
  );
  const pad = (value: string | undefined, fallback: number) => String(value === undefined || value === "" ? fallback : Number(value)).padStart(2, "0");
  const time = `${pad(fields.get("BYHOUR"), 9)}:${pad(fields.get("BYMINUTE"), 0)}`;
  const freq = fields.get("FREQ");
  if (freq === "HOURLY") {
    return { ...DEFAULT_SCHEDULE, mode: "hourly", intervalHours: Number(fields.get("INTERVAL") ?? 1) || 1, minute: Number(fields.get("BYMINUTE") ?? 0) || 0 };
  }
  if (freq === "DAILY") return { ...DEFAULT_SCHEDULE, mode: "daily", time };
  if (freq === "WEEKLY") {
    const days = (fields.get("BYDAY") ?? "").split(",").filter((code): code is WeekdayCode => WEEKDAYS.some((day) => day.code === code));
    if (days.join(",") === WEEKDAY_SET) return { ...DEFAULT_SCHEDULE, mode: "weekdays", time };
    return { ...DEFAULT_SCHEDULE, mode: "weekly", time, days: days.length ? days : ["MO"] };
  }
  return { ...DEFAULT_SCHEDULE };
}
