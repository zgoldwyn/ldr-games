import { randomUUID } from 'node:crypto';

/** Publish the workspace tree, retaining live levels that are not present there. */
export function planWorkspaceCatalogPublication(
  liveLevels,
  workspaceLevels,
  activeIndex,
  makeId = randomUUID,
) {
  if (!Array.isArray(workspaceLevels) || workspaceLevels.length === 0)
    throw new Error('The workspace has no levels to publish');
  if (!Number.isInteger(activeIndex) || activeIndex < 0 || activeIndex >= workspaceLevels.length)
    throw new Error('Choose an active workspace level before publishing');
  if (
    workspaceLevels.some((item) => !item?.id || !Number.isInteger(item.number) || item.number < 1)
  )
    throw new Error('Every workspace level needs an ID and a positive whole-number position');
  const numbers = workspaceLevels.map((item) => item.number);
  if (new Set(numbers).size !== numbers.length)
    throw new Error('Workspace level numbers must be unique before publishing');
  if (Math.max(...numbers) > liveLevels.length + workspaceLevels.length)
    throw new Error('Workspace level numbers have a gap too large to publish safely');

  const liveById = new Map(liveLevels.map((item) => [item.id, item]));
  if (liveById.size !== liveLevels.length) throw new Error('Live level IDs must be unique');
  const hasNewId = workspaceLevels.some((item) => !liveById.has(item.id));
  const represented = new Set();
  const records = workspaceLevels.map((item, workspaceIndex) => {
    const live = liveById.get(item.id);
    // A moved old level makes room for a genuinely new ID. Without a new ID,
    // a copy placed beyond the live catalog keeps its original level too.
    const copyOfLive = Boolean(live && !hasNewId && item.number > liveLevels.length);
    if (live && !copyOfLive && !represented.has(item.id)) represented.add(item.id);
    return { level: item, desiredNumber: item.number, workspaceIndex, priority: 0 };
  });
  for (const live of liveLevels)
    if (!represented.has(live.id))
      records.push({ level: live, desiredNumber: live.number, workspaceIndex: null, priority: 1 });

  records.sort(
    (first, second) =>
      first.desiredNumber - second.desiredNumber ||
      first.priority - second.priority ||
      (first.workspaceIndex ?? 0) - (second.workspaceIndex ?? 0),
  );
  const ids = new Set();
  const levels = records.map((record, index) => {
    let id;
    do id = `level-${index + 1}-${makeId()}`;
    while (ids.has(id));
    ids.add(id);
    const numbered = {
      ...record.level,
      id,
      number: index + 1,
      chapter: `Level ${index + 1}`,
    };
    delete numbered.order;
    return numbered;
  });
  return {
    levels,
    activeNumber: records.findIndex((record) => record.workspaceIndex === activeIndex) + 1,
    preservedLiveCount: records.filter((record) => record.workspaceIndex === null).length,
  };
}
