import type { PointerEvent } from 'react';

let supportsDisplayTransition: boolean | undefined;

export function isPointerOutsideDialog(
  event: PointerEvent<HTMLDialogElement>,
  dialog: HTMLDialogElement,
): boolean {
  const rect = dialog.getBoundingClientRect();
  return (
    event.clientX < rect.left ||
    event.clientX > rect.right ||
    event.clientY < rect.top ||
    event.clientY > rect.bottom
  );
}

/**
 * Probes real discrete `display` transition support using a temporary element so
 * Firefox versions that parse `allow-discrete` without transitioning `display`
 * still take the closing animation fallback path.
 */
function canTransitionDisplay(): boolean {
  if (supportsDisplayTransition !== undefined) return supportsDisplayTransition;
  if (
    typeof window === 'undefined' ||
    !window.CSS?.supports?.('transition-behavior', 'allow-discrete') ||
    !document.body
  ) {
    return false;
  }
  const probe = document.createElement('div');
  probe.style.cssText = 'transition: display 1s allow-discrete !important; display: block;';
  document.body.appendChild(probe);
  getComputedStyle(probe).display;
  probe.style.display = 'none';
  supportsDisplayTransition = getComputedStyle(probe).display === 'block';
  probe.remove();
  return supportsDisplayTransition;
}

function supportsTopLayerExit(): boolean {
  return (
    typeof window !== 'undefined' &&
    Boolean(window.CSS?.supports?.('overlay', 'auto')) &&
    canTransitionDisplay()
  );
}

export function openDialogModal(dialog: HTMLDialogElement | null): void {
  if (!dialog) return;
  dialog.removeAttribute('data-closing');
  if (!dialog.open) dialog.showModal();
}

export async function closeDialogAnimated(dialog: HTMLDialogElement | null): Promise<void> {
  if (!dialog || !dialog.open || dialog.hasAttribute('data-closing')) return;
  if (!supportsTopLayerExit()) {
    dialog.setAttribute('data-closing', '');
    const animations =
      typeof dialog.getAnimations === 'function' ? dialog.getAnimations({ subtree: true }) : [];
    if (animations.length > 0) {
      await Promise.race([
        Promise.allSettled(animations.map((animation) => animation.finished)),
        new Promise<void>((resolve) => window.setTimeout(resolve, 350)),
      ]);
    }
    if (!dialog.hasAttribute('data-closing')) return;
    dialog.removeAttribute('data-closing');
  }
  if (dialog.open) dialog.close();
}
