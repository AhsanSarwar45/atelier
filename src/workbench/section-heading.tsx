/**
 * The one heading a section of a form or a panel is titled with.
 *
 * The new-chat dialog had three sections in three styles — a dialog title over
 * the agents, sentence case over the accounts, and small caps over the
 * worktree — so three questions of equal weight looked like three unrelated
 * things (bw-ospn.3). Every section that names itself says it this way.
 */
export function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-xs font-semibold uppercase tracking-wider text-t-muted">{children}</h3>
  );
}
