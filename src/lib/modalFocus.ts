import { useEffect, useRef, type RefObject } from "react";

/** True while a dialog or the first-run wizard is on screen. A modal owns the keyboard:
 *  navigation chords and search must not fire behind it. */
export const overlayOpen = (): boolean =>
  typeof document !== "undefined" && !!document.querySelector(".modal-backdrop, .onboarding-backdrop");

const FOCUSABLE = "button, a[href], input, select, textarea, [tabindex]:not([tabindex='-1'])";

/**
 * Modal focus contract: the first control takes focus, Tab cycles inside `ref`, and the
 * previously focused element gets focus back when the modal unmounts. Esc is opt-in —
 * a dialog closes on it, the first-run wizard must not skip itself.
 *
 * Both callbacks live in refs: a parent that re-renders on a timer (the 1 s stats tick)
 * passes a fresh arrow each time, and an effect keyed on it would re-focus the first
 * control mid-typing.
 */
export function useModalFocus(ref: RefObject<HTMLElement | null>, onEscape?: () => void) {
  const escapeRef = useRef(onEscape);
  escapeRef.current = onEscape;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const focusables = () =>
      node
        ? [...node.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.hasAttribute("disabled") && el.offsetParent !== null)
        : [];

    // A modal can name the control it wants focused. When that one is disabled the node
    // itself takes focus rather than arming whichever button happens to come first —
    // a wizard must not put Return on "Skip setup".
    const autofocus = node?.querySelector<HTMLElement>("[data-autofocus]");
    if (autofocus) {
      if (autofocus.hasAttribute("disabled")) node?.focus();
      else autofocus.focus();
    } else {
      (focusables()[0] ?? node)?.focus();
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && escapeRef.current) {
        event.stopPropagation();
        escapeRef.current();
        return;
      }
      if (event.key !== "Tab" || !node) return;
      const list = focusables();
      if (list.length === 0) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      previous?.focus?.();
    };
  }, [ref]);
}
