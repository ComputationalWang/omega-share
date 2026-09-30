// The site's own notice when YouTube refuses the room's video (onError; research §1.1). YouTube's in-player
// text alone isn't enough: without this the transport would keep saying the room plays here.
const PREFIX = "This video can't play here";

/** Notice text for a YouTube player error code: 2, 5, 100, 101/150, or anything newer. */
export function playerErrorText(code: number): string {
  switch (code) {
    case 101:
    case 150:
      return `${PREFIX}: the owner doesn't allow playback on other sites.`;
    case 100:
      return `${PREFIX}: it's unavailable (removed or private).`;
    default:
      return `${PREFIX}: YouTube reported an error (code ${String(code)}).`;
  }
}
