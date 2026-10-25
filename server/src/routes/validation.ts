/**
 * 取请求体里的文字字段：没传返回 undefined，是文字就去掉首尾空白，传了别的类型（数字、对象……）直接报 400，
 * 免得后面 .trim() 炸成 "xxx.trim is not a function" 这种看不懂的 500。
 */
export function textField(value: unknown, name: string): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string") throw new Error(`参数 ${name} 应该是文字`);
  return value.trim();
}
