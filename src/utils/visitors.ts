import type { Member } from "../types.js";

/** Site field indices: visitor 1 → data[0], visitor 2 → data[2], visitor 3 → data[3] */
const DATA_INDICES = [0, 2, 3] as const;

export function getDataIndex(memberIndex: number): number {
  const dataIndex = DATA_INDICES[memberIndex];
  if (dataIndex === undefined) {
    throw new Error(`Invalid member index ${memberIndex}. Maximum 3 visitors.`);
  }
  return dataIndex;
}

export function getVisitorRowId(memberIndex: number): string {
  return memberIndex === 0 ? "formRow" : `formRow${memberIndex + 1}`;
}

/** Visitor 1 uses Male/Female; visitors 2+ use male/female. */
export function getGenderValue(member: Member, dataIndex: number): string {
  if (dataIndex === 0) {
    return member.gender;
  }

  if (member.gender === "Male") return "male";
  if (member.gender === "Female") return "female";
  return "Others";
}
