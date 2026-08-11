// Deciding when a control has been moved deliberately rather than brushed.
//
// A port of MoveDetector in cc2juno.py. A CC has to travel `threshold` counts
// while learning is armed before it counts as the answer, so catching a
// neighbouring knob on the way past no longer assigns it. The span tracked per
// CC is the widest excursion seen, so a sweep up and back down still registers.
// A switch that sends one value per press registers on the second press, when it
// sends the other value.

export const LEARN_MOVE_THRESHOLD = 6;

export class MoveDetector {
  constructor(threshold = LEARN_MOVE_THRESHOLD) {
    this.threshold = Math.max(0, threshold);
    this.spans = new Map();     // cc -> [lowest, highest] seen since the reset
  }

  reset() {
    this.spans.clear();
  }

  /** Record one CC message. True once that CC has moved far enough. */
  feed(cc, value) {
    let span = this.spans.get(cc);
    if (!span) {
      span = [value, value];
      this.spans.set(cc, span);
    } else if (value < span[0]) {
      span[0] = value;
    } else if (value > span[1]) {
      span[1] = value;
    }
    return span[1] - span[0] >= this.threshold;
  }
}
