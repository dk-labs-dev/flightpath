import { formatCount } from "@flightpath/flightpath/format";

// The count wording: a count agrees with its number, separators and all.

export function countWord(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

export function countLine(count: number, one: string, many: string): string {
  return `${formatCount(count)} ${countWord(count, one, many)}`;
}
