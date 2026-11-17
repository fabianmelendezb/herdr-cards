// Space groups and hidden spaces, kept in shared "space.organize" so the agents
// list can read them too:
//   { groups: [{ id, name, hidden }], member: { spaceId: groupId }, hidden: [spaceId] }
// Group order is display order. A worktree space with no group of its own
// follows its repo's space.

import { shared, setShared } from "herdr";

const KEY = "space.organize";

/** @returns {{ groups: { id: string, name: string, hidden: boolean }[], member: Record<string, string>, hidden: string[] }} */
export function organize() {
  const stored = shared(KEY) ?? {};
  return {
    groups: Array.isArray(stored.groups) ? stored.groups : [],
    member: stored.member && typeof stored.member === "object" ? stored.member : {},
    hidden: Array.isArray(stored.hidden) ? stored.hidden : [],
  };
}

function save(state) {
  setShared(KEY, state);
}

export function createGroup(name, spaceId = null) {
  const state = organize();
  const groupId = `g${Date.now().toString(36)}`;
  state.groups = [...state.groups, { id: groupId, name: name.trim() || "Group", hidden: false }];
  if (spaceId) state.member = { ...state.member, [spaceId]: groupId };
  save(state);
  return groupId;
}

export function renameGroup(groupId, name) {
  const state = organize();
  state.groups = state.groups.map((group) => (group.id === groupId ? { ...group, name: name.trim() || group.name } : group));
  save(state);
}

/** Deletes the group; its spaces stay, ungrouped. */
export function deleteGroup(groupId) {
  const state = organize();
  state.groups = state.groups.filter((group) => group.id !== groupId);
  state.member = Object.fromEntries(Object.entries(state.member).filter(([, memberGroupId]) => memberGroupId !== groupId));
  save(state);
}

export function setGroupHidden(groupId, hidden) {
  const state = organize();
  state.groups = state.groups.map((group) => (group.id === groupId ? { ...group, hidden } : group));
  save(state);
}

/** groupId null takes the space out of its group. */
export function moveToGroup(spaceId, groupId) {
  const state = organize();
  const member = { ...state.member };
  if (groupId) member[spaceId] = groupId;
  else delete member[spaceId];
  state.member = member;
  save(state);
}

export function setSpaceHidden(spaceId, hidden) {
  const state = organize();
  const rest = state.hidden.filter((id) => id !== spaceId);
  state.hidden = hidden ? [...rest, spaceId] : rest;
  save(state);
}
