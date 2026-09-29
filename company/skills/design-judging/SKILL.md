---
name: design-judging
description: Fixed rubric for judging omega-share design submissions (avatars, room, furniture, UI chrome). The CEO spawns an independent design-judge subagent with this rubric; the designer uses it to self-check before submitting.
---

# Design judging rubric

Score each criterion 1–5. **PASS** needs a total ≥ 30/40 and no criterion below 3. Otherwise **REVISE** with at most 5 concrete, actionable requests. The designer gets 3 revision rounds per set, then it escalates to the board.

| # | Criterion | 5 means |
|---|---|---|
| 1 | Readability at 1× | Silhouette, pose and facing are obvious at native size on the room floor |
| 2 | Distinctness | The 4 avatars can't be confused at a glance (shape, palette and accessory all differ) |
| 3 | Habbo-inspired, not copied | Clearly evokes cosy isometric pixel rooms, and nothing is traceable to Sulake/Habbo art, names or logos |
| 4 | Style consistency | Shared palette, outline weight, light direction and pixel density across every asset |
| 5 | Isometric correctness | True 2:1 grid, consistent anchors/feet points, seats line up with the seated poses |
| 6 | Technical fitness | PNG sprite sheet + JSON atlas as documented; power-of-two-friendly; no stray pixels or alpha fringes |
| 7 | Budget | The set's share of the ≤ 300 KB compressed art budget is respected (report the actual bytes) |
| 8 | Charm | Would you want to sit in this room? Personality in the idle/seated poses |

Judge process: render every sprite (e.g. compose a preview PNG and view it), measure the byte sizes, then fill the table honestly. Never judge on the designer's description alone.
