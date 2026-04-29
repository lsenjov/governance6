import { useEffect } from "react";

/**
 * Side / bottom drawer primitive — backdrop + aside with a header and
 * a close button. Closes on Escape and on backdrop click.
 *
 * Originally defined inline in `src/pages/GameDetailPage.tsx`; extracted
 * here so additional drawer consumers (e.g. `<GmTodoDrawer>`) can
 * import the primitive without dragging in the 4000-line page module.
 *
 * Pass `bottom` to anchor the drawer to the bottom of the viewport
 * instead of the side; the existing player-rail "Game summary" sheet
 * uses this variant.
 */
export function Drawer({
  onClose,
  title,
  bottom,
  children,
}: {
  onClose: () => void;
  title: string;
  bottom?: boolean;
  children: React.ReactNode;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside
        role="dialog"
        aria-label={title}
        className={`drawer${bottom ? " bottom" : ""}`}
      >
        <div className="drawer-header">
          <h3>{title}</h3>
          <button
            type="button"
            className="secondary"
            onClick={onClose}
            aria-label="Close"
            style={{
              marginLeft: "auto",
              padding: "0.125rem 0.5rem",
              fontSize: "0.85rem",
            }}
          >
            ✕
          </button>
        </div>
        {children}
      </aside>
    </>
  );
}
