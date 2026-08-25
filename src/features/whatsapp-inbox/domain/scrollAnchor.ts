const DEFAULT_STICK_THRESHOLD_PX = 80;

export function shouldStickToBottom(
  el: { scrollTop: number; scrollHeight: number; clientHeight: number },
  thresholdPx: number = DEFAULT_STICK_THRESHOLD_PX,
): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= thresholdPx;
}

export function anchorOffsetAfterPrepend(
  previousScrollHeight: number,
  nextScrollHeight: number,
  previousScrollTop: number,
): number {
  return previousScrollTop + (nextScrollHeight - previousScrollHeight);
}
