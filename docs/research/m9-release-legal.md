# M9 research: the minimum legal set for a public release

[OME-761](/OME/issues/OME-761) (M9 Wave R, plan item 2, parent [OME-759](/OME/issues/OME-759)). Researched 2026-10-10. Docs only, read-only on code. Repo refs are `file:line` on `main@70e5921`. Every legal statement cites a primary source (EUR-Lex, gesetze-im-internet.de, the licence texts, the platforms' own docs). **[unverified]** marks claims no primary source confirmed. This is engineering research, not legal advice: the operator should have a lawyer read the final pages before launch if the budget allows it.

**What we are** (inputs for every section below): `https://omega-share.duckdns.org`, one Hetzner box in Germany (ADR 0020), non-commercial, no accounts, no ads, no payments. Anyone can create a room with a free-text title (≤ 32 characters, `ROOM_TITLE_MAX_LENGTH`, `packages/shared/src/constants.ts:14`). Public rooms are listed in `GET /rooms` for anyone. Private rooms need an invite key in the URL fragment (ADR 0028 §4). Rooms have live chat, held in memory only and never stored (ADR 0020 §11). Videos are third-party embeds (YouTube, Twitch, Vimeo, and the click-to-load generic tier of ADR 0024). We don't host the videos themselves. Abuse reports go through `POST /rooms/:id/report` (ADR 0033), and the operator takes rooms down with the CLI (`docs/ops/rooms.md`). The operator's identity and country are **not recorded anywhere in the repo**, and this doc doesn't guess them.

---

## Summary

- **The DSA very probably applies, and we are an "online platform", not just a "hosting service"**, because public rooms put user-written titles and chat in front of anyone who opens the lobby. A micro enterprise (or a non-economic hobby project) is exempt from the heavy platform duties (Arts 20–28, Art. 15 reports, Art. 24(5) transparency-database uploads). **It is not exempt** from Arts 11, 12, 14, 16, 17 and 18. Those are cheap, and all of them are pages, an email inbox and runbook steps.
- **Our report dialog is a good abuse flag, but it is not an Art. 16 notice mechanism by itself.** It lacks the reporter's explanation of *why it is illegal* as a distinct element, a way to give a name and email, the good-faith statement, and the reporter's choice between "illegal" and "breaks the rules". The cheapest fix that keeps ADR 0033's anonymity: keep the anonymous dialog as it is, and add an **Art. 16 notice route by email** (Contact and notices page), linked from the dialog. No new stored personal data on the server.
- **Art. 17 statements of reasons are owed only where we know the affected user's electronic contact details.** With no accounts we never do. The 4006 notice is still worth one more sentence naming the ground (illegal content vs. terms) and pointing at the terms.
- **Art. 18 needs a runbook step**: a "someone may be in danger" report that suggests a threat to life or safety goes to the police of the country concerned (or Europol when that's unclear).
- **Imprint:** the server's location in Germany doesn't make German imprint law apply. What applies depends on where the operator is established. Every EU country has the e-Commerce Directive Art. 5 minimum (name, geographic address, email). In Germany, a non-commercial site still owes name and address under MStV § 18(1). **Name and postal address are mandatory in every EU scenario we looked at, and only the board can supply them.**
- **GDPR gap found on the way:** `privacy.html` names no controller and no contact address, and it sends deletion requests to public GitHub issues. GDPR Art. 13 requires the controller's identity and contact details. This is a must-fix.
- **Share previews:** the recommendation stands, with four additions: apply the same `titleBlocked` check as the lobby, show nothing for taken-down or unknown rooms, never use a provider thumbnail or video title, and keep `X-Robots-Tag: noindex, nofollow` on `/r/*`. **Don't `Disallow: /r/` in robots.txt**: it would hide our `noindex` from search crawlers, and several preview bots ignore robots.txt anyway, so it can't be what keeps a preview safe.
- **Must fix before release (ranked):** operator identity and contact data (board), Contact and notices page with the Art. 11/12 points of contact and the Art. 16 route, Terms of use (Art. 14), privacy page controller and contact section, Licences and credits page (CC BY-SA attribution, third-party notices), Art. 18 runbook step. Everything else can wait (list at the end).

---

## 1. Does the DSA apply, and as what?

### 1.1 Information society service
The DSA covers "intermediary services", which are information society services (DSA Art. 3(a), referring to Directive (EU) 2015/1535 Art. 1(1)(b): "any service normally provided for remuneration, at a distance, by electronic means and at the individual request of a recipient of services"). A free, ad-free, non-commercial site sits at the edge of "normally provided for remuneration". The Court of Justice reads that phrase widely: remuneration "does not require the service to be paid for by those for whom it is performed" (CJEU C-484/14 *Mc Fadden*, para. 41, free Wi-Fi offered to advertise a shop; see also C-291/13 *Papasavvas* on an ad-funded free news site). A purely private, non-economic project may fall outside, but no primary source says where the line sits for a hobby service open to the public.

**Recommendation:** treat the DSA as applying. The duties that would bind us cost a few pages and an inbox, and being wrong the other way is the expensive mistake.

### 1.2 Hosting service and online platform
- **Hosting service:** storing information provided by, and at the request of, a recipient of the service (Art. 3(g)(iii)). Room titles, layouts, the queued video URL and chat lines are all that.
- **Online platform:** a hosting service that, at the request of a recipient, stores **and disseminates information to the public**, unless that is a minor and purely ancillary feature (Art. 3(i)). "Dissemination to the public" means making information available, at the request of the recipient who provided it, to a potentially unlimited number of third parties (Art. 3(k)). Recital 14 keeps interpersonal communication services such as email and private messaging outside the definition, and treats a group as public only where users are admitted "without a human decision or selection" of whom to grant access.
- **What that means for us:** a **public room** is listed in `GET /rooms` and anyone can walk in and read its title and chat, with no human choosing who enters, so public rooms make us an online platform. A **private room** is closer to the closed groups of Recital 14 (its owner hands out the invite link), but that doesn't change the classification of the service as a whole.

### 1.3 Size: micro or small enterprise
Arts 19 and 29 exempt micro and small enterprises (Commission Recommendation 2003/361/EC) from Section 3 (Arts 20–28) and Section 4 (Arts 29–32). A micro enterprise has fewer than 10 staff and an annual turnover or balance sheet of at most EUR 2 million (Recommendation Annex Art. 2(3)). The Recommendation defines an enterprise as an entity "engaged in an economic activity" (Annex Art. 1). If omega-share is not an economic activity at all, §1.1 already questions whether the DSA applies. Either way we land on the same set of duties below.

What the exemption **does not** cover: Chapter III Section 1 (Arts 11–15) and Section 2 (Arts 16–18) apply to every intermediary or hosting provider, whatever its size. Art. 15's annual transparency report has its own exemption for micro and small enterprises that are not VLOPs (Art. 15(2)). Art. 19(1) keeps one Section 3 duty for us: Art. 24(3), giving the Digital Services Coordinator, on request, the information on average monthly active recipients.

### 1.4 What we must do: the article-by-article table

| Article | Duty | Applies to us? | What we have | What's missing |
|---|---|---|---|---|
| **Art. 6** | Hosting liability shield: not liable if we don't know about illegal content and act expeditiously once we do | Yes (a benefit, not a duty) | Takedown CLI, daily queue check (`docs/ops/rooms.md`) | Nothing. The shield is why notice and action matter. |
| **Art. 8** | No general monitoring obligation | Yes (a benefit) | `ROOM_TITLE_BLOCKLIST` is voluntary | Nothing |
| **Art. 11** | Single point of contact for Member State authorities, the Commission and the Board. Publish the information needed to reach it, easy to find and up to date. Art. 11(3): name the languages it accepts, which must include, besides a language broadly understood by as many Union citizens as possible, at least one official language of the Member State of main establishment | Yes | Nothing | An email address (can be the same inbox as Art. 12) and the language line on the Contact page: English plus an official language of the operator's country (German if established in Germany) |
| **Art. 12** | Single point of contact for users: direct and rapid electronic communication, user-friendly, and users must be able to choose a way that doesn't rely only on automated tools | Yes | The report dialog, which can't take a reply. Privacy page sends people to public GitHub issues. | Same inbox, read by a person, published on the Contact page |
| **Art. 13** | Legal representative in the EU | Only if the operator is established **outside** the EU and the service is offered in the Union | — | **Board-only** fact: where the operator is established (§3.3) |
| **Art. 14** | Terms and conditions: what we restrict, content-moderation policies, procedures, measures and tools, including any automated decision-making and human review, and complaint handling. Clear, plain, unambiguous language, publicly available and easy to find, machine-readable. Tell users about significant changes. Explain in a way minors understand if the service is mainly aimed at or used by minors. Apply them diligently, objectively and proportionately. | Yes | Nothing: there is no terms page | The Terms of use page (§4.1) |
| **Art. 15** | Annual transparency report | **No** (Art. 15(2), micro or small, not VLOP) | — | — |
| **Art. 16** | Notice and action mechanism (§2) | Yes | Anonymous report dialog | See §2 |
| **Art. 17** | Statement of reasons to affected users when we remove or restrict their content | Only where we know the user's electronic contact details (Art. 17(2)) | Never known: no accounts | Nothing mandatory. Good practice in §2.4. |
| **Art. 18** | Notify law enforcement of suspected criminal offences involving a threat to someone's life or safety | Yes | `danger` reason exists; no runbook step | Runbook step (§2.5) |
| **Arts 20–28** | Internal complaint handling, out-of-court settlement, trusted flaggers, misuse measures, transparency-database uploads, dark patterns, ads, recommender systems, protection of minors | **No** (Art. 19(1), micro or small), except Art. 24(3) on request | — | Answer a DSC request for user numbers if one ever comes |

---

## 2. Notice and action (Art. 16), statements of reasons (Art. 17), criminal offences (Art. 18)

### 2.1 What Art. 16 requires
- **16(1):** mechanisms that let anyone notify us of specific items they consider illegal content. Easy to access and user-friendly, and they may be purely electronic.
- **16(2):** the mechanism must make it easy to submit notices that contain all of:
  - (a) a sufficiently substantiated explanation of why the person considers the information illegal;
  - (b) a clear indication of its exact electronic location, such as the exact URL(s), and further information if needed;
  - (c) the name and email address of the person submitting it, **except** for information considered to involve one of the offences in Arts 3 to 7 of Directive 2011/93/EU (child sexual abuse and exploitation);
  - (d) a statement confirming their good-faith belief that the information and allegations are accurate and complete.
- **16(3):** a notice with those elements gives us actual knowledge (and so ends the Art. 6 shield) if a diligent provider could see it's illegal without a detailed legal examination.
- **16(4):** if the notice includes electronic contact information, we send a confirmation of receipt without undue delay.
- **16(5):** we tell the notifier our decision without undue delay, and mention the possible routes of redress.
- **16(6):** we handle notices in a timely, diligent, non-arbitrary and objective manner, and say in the decision notice if we used automated means.

### 2.2 Does our report dialog meet it?

| Art. 16 element | Our dialog (`apps/web/src/report/dialog.ts`, ADR 0033) | Meets it? |
|---|---|---|
| 16(1) easy to access, electronic | "Report room" key in every room, one click | **Yes** |
| 16(1) open to *anyone* | Needs the room page. A refused visitor can still report (ADR 0033 §1). Someone who saw a room's title in a shared link but can't open the room can't report it without opening it | Mostly. The Contact page closes the gap. |
| 16(2)(a) explanation of why it is illegal | Six reason categories plus an optional 300-character note. No distinct "why is this illegal" field, and no illegal-vs-terms choice | **Partly.** The note can carry an explanation, but the form doesn't ask for one. |
| 16(2)(b) exact location | The room id is implicit. The report snapshots the title and the playing URL. A specific chat line can't be pointed at, and chat isn't kept (ADR 0020 §11), so a chat-only offence leaves no evidence | **Yes for rooms, titles and videos. No for chat lines.** |
| 16(2)(c) name and email | Deliberately not collected (ADR 0033 §1: strict body, no contact field) | **No.** The mechanism must *allow* them. |
| 16(2)(d) good-faith statement | None | **No** |
| 16(4) confirmation of receipt | On-screen "Thanks, we got it". No contact details are given, so there's no one to send one to | Yes for anonymous reports. Needs real email replies for email notices. |
| 16(5) decision and redress | "We can't reply here" | Not possible anonymously. Needs the email route. |
| 16(6) timely, diligent, no automation | Daily queue check, human decision, no automated moderation | **Yes** (the Terms should say so) |

**Verdict:** the dialog is a valid anonymous flag. Art. 16 doesn't forbid anonymous reports; it requires that a notice *with* all four elements be possible. Today it isn't.

### 2.3 Recommended fix (smallest change that complies)
1. **Keep the anonymous dialog exactly as it is.** Its privacy promises (ADR 0033 §3, `privacy.html` "Reports") stay true, and it remains the fastest way to flag a room.
2. **Add an Art. 16 email route** on the Contact and notices page: one inbox (the same as Arts 11 and 12), with a short template listing the four elements (what and where, why it's illegal, your name and email, the good-faith sentence), and the note that name and email are optional for child-abuse material. The operator answers from that inbox: receipt (16(4)), decision and redress (16(5)).
3. **One line in the dialog** under the reasons: "Reporting illegal content and want an answer? Use our notice form / email instead." linking the Contact page. It's a text and link change in `apps/web` (W-side), no contract change, no server change.
4. **Not recommended now:** adding name and email fields to `ReportRequestSchema`. It would store personal data that ADR 0033 §3 and ADR 0028 §7 promise we never keep, it would need an ADR amendment, a migration, retention rules and privacy-page changes, and email does the same job.
5. **Can wait:** an illegal-vs-terms choice in the dialog (a seventh field or a second step). The operator can triage by reason today, and the email route covers illegal-content notices properly.

### 2.4 Statement of reasons (Art. 17)
Art. 17(1) requires a clear and specific statement of reasons to every affected recipient when we restrict their content, but Art. 17(2) limits it to cases where the provider knows the relevant electronic contact details. We have no accounts and never learn a room owner's contact details, so nothing is owed today. Good practice that costs nothing:
- Name the ground in the 4006 notice: "This room was closed by the omega-share team after a report, because it broke our [Terms of use](/terms) or the law." (W-side copy change, can wait.)
- Record the ground on the takedown (illegal content, and under which law if known; or which Terms rule), as `docs/ops/rooms.md` step 6 already asks for a reason on the issue. If the operator ever answers a room owner who writes in, that record lets them give the Art. 17(3) elements.

### 2.5 Notification of criminal offences (Art. 18)
When we become aware of information that gives rise to a suspicion that a criminal offence involving a threat to the life or safety of a person or persons has taken place, is taking place or is likely to take place, we must promptly inform the law enforcement or judicial authorities of the Member State(s) concerned and give all relevant information available (Art. 18(1)). If it's not clear which country is concerned, we inform the authorities of the country where we are established (or where our legal representative is), or Europol, or both (Art. 18(2)).

**Gap:** `docs/ops/rooms.md` has no step for this. Add to the takedown runbook: "If a `danger` report or any other report suggests that someone's life or safety is at risk, report it to the police (country of the people involved if known, otherwise where the operator is established, or Europol) before or alongside the takedown, with the room id, the time, the title and the playing URL. Record that you did, not what you sent." This is a docs change in `docs/ops/` and an operator duty, no code. Note that we hold nothing about the people involved, so "all relevant information available" is the report row.

---

## 3. Provider identification (imprint)

### 3.1 Where the server is doesn't decide it
The e-Commerce Directive defines an established provider as one that effectively pursues an economic activity using a fixed establishment, and says that "the presence and use of the technical means and technologies required to provide the service do not, in themselves, constitute an establishment of the provider" (Directive 2000/31/EC Art. 2(c)). Our Hetzner box in Germany therefore doesn't by itself make German imprint law apply. The operator's own place of establishment does (country-of-origin principle, Directive 2000/31/EC Art. 3; the German transposition is in the DDG **[§ number unverified]**).

### 3.2 If the operator is in Germany
- **DDG § 5** (the old TMG § 5) applies to providers of **"geschäftsmäßige, in der Regel gegen Entgelt angebotene digitale Dienste"** (business-like services normally offered for payment). It asks for name and address (legal persons: legal form and authorised representative), fast electronic contact including an email address, register entries, supervisory authority, profession details and VAT or business IDs where they exist. A hobby site with no income is probably outside "in der Regel gegen Entgelt". We can't rely on that, though. The line is fuzzy, and the next rule applies anyway.
- **MStV § 18(1)** (Medienstaatsvertrag): providers of telemedia that do **not** serve exclusively personal or family purposes must make **name and address** easily recognisable, directly accessible and permanently available, and for legal persons also the name and address of the authorised representative. A public site where strangers create rooms and chat is not "exclusively personal or family". **This applies to omega-share whatever the DDG answer is.**
- **MStV § 18(2)** (a person responsible for content, with name and address) applies only to journalistic-editorial offerings. A watch-room site isn't one, so it doesn't apply.

### 3.3 If the operator's country is unknown or elsewhere
- **Another EU country:** that country's transposition of e-Commerce Directive **Art. 5(1)** applies: (a) name, (b) geographic address, (c) details including an email address for rapid, direct and effective contact, then (d)–(g) register, supervisory authority, regulated profession and VAT number only where they apply. Same core fields as Germany.
- **Outside the EU:** EU imprint law doesn't follow the operator abroad. But if the DSA applies to a provider offering services in the Union without an EU establishment, **Art. 13** requires a written designation of a legal representative in one Member State where the service is offered, and the representative's name, postal address, email and phone number must be notified to the Digital Services Coordinator there and made public. For a free hobby site this is expensive (a paid representative service). A service is "offered in the Union" only with a "substantial connection to the Union": an establishment in the Union, or specific factual criteria "such as: a significant number of recipients of the service in one or more Member States in relation to its or their population; or the targeting of activities towards one or more Member States" (DSA Art. 3(d) and (e)). Designating a representative does not itself create an establishment (Art. 13(5)). An English-language site hosted in Germany and advertised nowhere specific is a borderline case.
- **Recommendation:** the board states where the operator is established, before release. That one fact decides between §3.2, the Art. 5 transposition of another EU country, or an Art. 13 question for a lawyer.

### 3.4 Fields to publish (all board-only)
These are facts only the operator can supply. **Nobody else should write them, and this doc doesn't.**

| Field | Mandatory when | Source |
|---|---|---|
| **Operator's full name** (person) or name and legal form (organisation) | Always | MStV § 18(1); ECD Art. 5(1)(a); DDG § 5(1) no. 1 |
| **Postal address where they can be served** (no P.O. box) | Always | MStV § 18(1); ECD Art. 5(1)(b); DDG § 5(1) no. 1 |
| **Authorised representative's name and address** | Only if the operator is a legal person (association, company) | MStV § 18(1); DDG § 5(1) no. 1 |
| **Email address**, read by a person | Always (also the DSA Arts 11/12 contact) | ECD Art. 5(1)(c); DDG § 5(1) no. 2; DSA Arts 11, 12 |
| A second fast contact channel (phone or a contact form) | DDG § 5 only if it applies (the courts read "schnelle elektronische Kontaktaufnahme" as more than email alone **[unverified]**) | DDG § 5(1) no. 2 |
| Register, register number | Only if registered (e.g. an e.V.) | DDG § 5(1) no. 4; ECD Art. 5(1)(d) |
| VAT ID | Only if they have one | DDG § 5(1) no. 6; ECD Art. 5(1)(g) |
| **Country of establishment** | Not published by law, but decides which rules apply | §3.1 |
| **Languages accepted** at the point of contact | Always (DSA Art. 11(3)) | Board decides: a widely understood language (English) plus at least one official language of the country of establishment |
| EU legal representative | Only if established outside the EU (§3.3) | DSA Art. 13 |

Hetzner, DuckDNS, the GitHub org and agent names are not substitutes for these.

---

## 4. Recommended page set

Four pages, linked from the footer of `index.html` (today it has "Source · Privacy", `apps/web/index.html:37-39`) and from the room's popout footer (`apps/web/room.html:17`, "Source" only). Plain static HTML like `privacy.html`: same CSP, no scripts, so no frame-budget or bundle cost. Plain language, the same voice as the privacy page. Owner: Lead/web (`apps/web`); the facts in **bold board-only** slots come from the board.

### 4.1 Terms of use (`/terms.html`), Art. 14
1. **Who runs this** (link to Contact) and that it's a free, non-commercial project offered as is.
2. **What omega-share does:** rooms, embedded players, chat, the extension. We don't host videos. They play in the provider's player under its own terms.
3. **What you must not do** (the content rules the takedown enforces): illegal content of any kind; sexual content; violence or gore; hate, harassment or threats; spam and scams; sharing someone's personal data; impersonating the operator; room titles that do any of these; anything that infringes copyright, such as sharing videos uploaded without permission. Map the six report reasons to these rules so a report and a takedown point at the same text.
4. **How we moderate** (Art. 14(1) content): people report rooms; a person at omega-share reads the queue at least daily; there's no automated moderation except a title blocklist that keeps matching rooms out of the lobby and stops new ones being created; the action is ending the room for good (takedown, close code 4006) and keeping its id dead; room owners can kick and mute (ADR 0030); there are no accounts, so there are no bans or suspensions of people.
5. **Reporting:** the in-room report (anonymous, no reply) and the notice route on the Contact page (with reply). What a notice should contain (Art. 16(2)).
6. **Complaints about our decisions:** write to the Contact address. (Art. 20 internal complaint handling doesn't apply to a micro enterprise, but Art. 14(1) asks the terms to describe any complaint handling we have, so say what there is.)
7. **Age:** the board decides a minimum age, or "not directed at children". Art. 14(3) asks for child-friendly wording only if the service is mainly aimed at or used by minors; it isn't. **Board-only decision.**
8. **No warranty and liability limits.** One plain paragraph. Wording that's valid depends on the operator's country (consumer law limits disclaimers): **lawyer or board decides** **[unverified]**.
9. **Changes to these terms:** we post a notice on the site for significant changes (Art. 14(2)), with the date of the current version.
10. **Source code and licences:** link to Licences and credits.

Machine-readable: a static HTML page with headings is enough. No primary source we found defines a stricter format for Art. 14(1) **[unverified]**.

### 4.2 Contact and notices (`/contact.html`), Arts 11, 12, 16, imprint
1. **Who runs omega-share:** the imprint fields from §3.4. **Board-only.**
2. **Contact:** one email address read by a person, the languages we answer in (Art. 11(3): English plus an official language of the operator's country), what to expect (we answer within N days; **board** sets N).
3. **For authorities:** the same address is our single point of contact for Member State authorities, the European Commission and the European Board for Digital Services (Art. 11).
4. **Reporting illegal content (notice and action):** what to include (the four Art. 16(2) elements as a short template), that name and email are not needed for child sexual abuse material, that we confirm receipt and tell you our decision, and that an anonymous report from inside the room is also possible but gets no answer.
5. **Removing a room you can't delete yourself** (replaces the GitHub-issue advice in `privacy.html` "Questions and deletion": public issues are the wrong place for that).
6. **Security reports:** the same address, or a `SECURITY.md` in the repo.

### 4.3 Licences and credits (`/credits.html`), AGPL-3.0 §13, CC BY-SA 4.0, third-party notices
1. **Source code (AGPL-3.0 §13):** "omega-share is free software under the GNU Affero General Public License v3.0 only. The source code of the version running on this site is at …". AGPL §13 requires that a modified version running as a network service *prominently offer* all users interacting with it remotely an opportunity to receive the Corresponding Source **of that version**. Today's footer "Source" link (`apps/web/source.ts:6`, the public repo) meets "prominently offer". To also meet "of that version", link the **deployed commit** (`…/tree/<sha>`) rather than the default branch: `deploy.sh` knows the sha at build time and `VITE_SOURCE_URL` already exists. Can wait if deploys only ever come from `main` and the repo stays public, but it's a two-line change and removes the doubt.
2. **Art (CC BY-SA 4.0 §3(a)):** "The art (avatars, room, furniture, UI) is original work by **[creator names or "the omega-share contributors"; board decides]**, © **[year]**, licensed under CC BY-SA 4.0 (link to the licence). Source: `assets/` in the repository (link)." Plus the licence's disclaimer reference, and "modified" where it is. §3(a)(2) allows doing this in any reasonable manner for the medium, and a credits page linked from the footer is that.
3. **Third-party notices:** the site ships `pixi.js` and `valibot` in its bundle (`apps/web/package.json`), both MIT. MIT requires that the copyright and permission notice be included in all copies or substantial portions, and serving the bundle to browsers is giving out copies. List each bundled package with its licence and copyright line, generated at build time from `node_modules` (a small build step in `apps/web`, or a checked-in list kept current by a test). The extension's store zips need the same file. The server's dependencies (Hono) aren't distributed, so they need no notice beyond the AGPL source offer.
4. **Trademarks:** YouTube, Twitch and Vimeo are trademarks of their owners, used only to name the players. omega-share isn't affiliated with them.

### 4.4 Privacy (`/privacy.html`, existing): GDPR additions
The page is good on what we keep. GDPR Art. 13(1) also requires: (a) the controller's identity and contact details, (c) the purposes and legal basis of the processing, and Art. 13(2)(b) the rights of access, erasure and so on, and (d) the right to lodge a complaint with a supervisory authority. The household exemption (Art. 2(2)(c)) doesn't cover a public website. Add:
1. **Controller:** the operator's name and contact (**board-only**, the same as the imprint).
2. **Legal basis** for each thing we process: in-memory rate-limit counting by network address, and report notes (legitimate interest in keeping the service safe, Art. 6(1)(f)); the room data people create (providing the service they asked for, Art. 6(1)(b)) **[lawyer to confirm]**.
3. **Your rights** and **complaint to a supervisory authority** (the one where the operator is established, or the user's own).
4. **Hosting processor:** Hetzner Online GmbH, Germany, hosts the server.
5. Replace "open an issue on the project's source repository" with the Contact address.

---

## 5. Per-room share previews (Open Graph)

### 5.1 What a preview does
When someone pastes `https://omega-share.duckdns.org/r/<id>` into a chat app or social network, the app's bot fetches the page and shows `og:title`, `og:description` and `og:image` from the HTML (ogp.me). Bots don't run our JS, so the server would have to write the tags into the HTML it serves for `/r/<id>`. Today every site route gets the same `index.html` (`apps/server/src/static.ts:6`, `mountSite`), with only `<title>omega-share</title>` (`apps/web/index.html:11`).

What gets shown is **republished by a third party, cached by it, and outside our control**: we can't take a preview back after a takedown or a rename, and it can show up where the link is pasted, not in our room.

### 5.2 Recommendation: confirmed, with four additions
Show a room's title only when **all** of these hold, otherwise the generic site preview:
1. The room exists, is **public**, and isn't taken down. (Already in the recommendation; the takedown part is new.) Private and invite-only rooms get the generic preview because a room id is not a secret (ADR 0028 §4: the Twitch SDK sends `location.href` to Twitch) and the bot never sees the `#k=` fragment, so it can't tell an invited sharer from anyone else.
2. **The title passes `titleBlocked`**, the same check that keeps a room out of `GET /rooms` (`apps/server/src/http.ts:207-215`). A title we hide from our own lobby mustn't be pushed into other people's chats. (New.)
3. **Escaped for an HTML attribute** (`&`, `"`, `<`, `>`, like `escapeAttr` in `apps/web/source.ts:22`) and capped. It's already ≤ 32 characters by schema; the server should still cut at `ROOM_TITLE_MAX_LENGTH` in case a seeded or legacy row is longer, and wrap it: `og:title` = `<title> · omega-share`.
4. **Nothing else from the room:** no member count, nicknames, chat, owner, queue, the playing video's title, URL or provider **thumbnail** (another site's copyrighted image served under our name, and fetching it would also tell the provider about every link unfurl), and no per-room `og:image`. Use one static site image (our own CC BY-SA art) for every preview. (New.)

Two more details for the implementer:
- Send `Cache-Control: no-cache` on the per-room HTML (as today for `index.html`), so a rename or takedown shows up on our side at once. Platform caches are out of our hands. The Terms or ops runbook should say so.
- The per-room HTML is a string template on an in-memory room lookup. It needs no new dependency and costs microseconds per request. It must not log titles. It's server work (`apps/server/src/static.ts`), and the `og:` tags need a placeholder in `index.html` (Lead/web), like `%OMEGA_SOURCE_URL%`.

### 5.3 Robots
- **Keep `X-Robots-Tag: noindex, nofollow` on `/r/*`** (`apps/server/src/http.ts:221`, tested in `apps/server/test/room-create.test.ts:483`). It keeps rooms out of search results.
- **Don't `Disallow: /r/` in robots.txt.** A crawler that may not fetch a page never sees its `noindex`, and Google says a disallowed URL "can still be indexed if linked to from other sites". And robots.txt is no privacy control for previews: Slack says its unfurler does "not currently honor robots.txt", and Meta says its crawler "might bypass robots.txt" for security checks. Whether X's Twitterbot honours it is **[unverified]** (X's developer docs answered 402). What a preview may show has to be decided by the server's HTML (§5.2), not by robots.txt.
- **Add a `robots.txt`** (none exists today, so `/robots.txt` falls through to the SPA shell): allow everything by default, `Disallow:` the API and machine paths (`/rooms`, `/ws`, `/metrics`) that have no reason to be crawled, and no `Sitemap:`. Serving a real file also stops the SPA shell answering `robots.txt` with HTML.

---

## 6. Other things checked

- **Copyright and embedding.** We don't store videos; we embed players and pass URLs. A link to works freely accessible on another site reaches no "new public" and is not a communication to the public (CJEU C-466/12 *Svensson*, paras 24–28). Framing that circumvents protection measures the rightholder put in place against framing *is* one (C-392/19 *VG Bild-Kunst*). We use the providers' official embed players, which the rightholder can switch off per video. (C-348/13 *BestWater*, a reasoned order on framing, is often cited too; **[unverified]** here.) We aren't an online content-sharing service provider under Directive (EU) 2019/790 Art. 2(6): that covers services whose main purpose is to "store and give the public access to a large amount of copyright-protected works … uploaded by its users, which it organises and promotes for profit-making purposes". We store no works, and we have no profit purpose. A link to infringing content is still a notice-and-action case: the Terms and the Contact page cover it.
- **`localStorage` (nickname, avatar, room secrets).** Storing information on the user's device needs consent unless it is strictly necessary for a service the user explicitly asked for (ePrivacy Directive 2002/58/EC Art. 5(3)). Nickname, avatar and owner and invite keys are needed to provide the rooms the user asked for, so no consent banner is needed. The privacy page already explains them. **[unverified]** that every stored key qualifies; re-check if anything non-essential is ever stored.
- **Extension.** Store listings already carry a privacy policy (the same page). The Licences page should cover the extension's bundled code too.

---

## 7. Gaps, ranked

### Must fix before a public release
1. **Operator identity and contact (board-only).** Name, postal address, a person-read email inbox, the country of establishment, and the languages answered. Every other item depends on it. *Owner:* board, via the CEO. *Size:* facts, no code.
2. **Contact and notices page** with the imprint, the Art. 11 and 12 points of contact and the Art. 16 notice route (§4.2), plus the one-line link from the report dialog (§2.3 step 3). *Owner:* Lead/web. *Size:* one static page and a copy change.
3. **Terms of use** (Art. 14, §4.1). *Owner:* Lead/web for the page, board for the age line and liability wording. *Size:* one static page.
4. **Privacy page GDPR additions** (§4.4): controller, legal bases, rights, supervisory authority, no more "open a GitHub issue". *Owner:* Lead/web, board facts. *Size:* copy.
5. **Licences and credits page** (§4.3): CC BY-SA attribution for `assets/`, MIT notices for the bundled `pixi.js` and `valibot`, the AGPL source offer. *Owner:* Lead/web. *Size:* a page plus a build-time notices list.
6. **Footer links** to all four pages on the home page and in rooms. *Owner:* Lead/web. *Size:* tiny.
7. **Art. 18 runbook step and the notice-handling routine** in `docs/ops/rooms.md`: check the notice inbox with the report queue, confirm receipt, answer with the decision, police or Europol for threats to life or safety. *Owner:* server (`docs/ops/`) and operator. *Size:* docs.

### Can wait (after release, in this order)
8. **Per-room Open Graph previews** (§5.2). They're a feature, not a legal duty; if they ship, ship them with the §5.2 rules. The generic site preview needs no per-room logic and can go in with the pages.
9. **`robots.txt`** (§5.3). Low risk today because `noindex` already covers `/r/*`.
10. **Source link to the deployed commit** (§4.3 item 1).
11. **Ground in the 4006 notice and on the takedown record** (§2.4).
12. **Illegal-vs-terms choice in the report dialog** (§2.3 step 5), and a way to point at a chat line. Both are bigger: a contract change and, for chat, keeping evidence we don't keep today.
13. **Lawyer review** of the Terms, the liability paragraph and the legal bases, once the operator's country is known.

### Not needed (and why)
- Annual transparency reports (Art. 15(2)), the transparency database (Art. 24(5)), internal complaint system and out-of-court settlement (Arts 20 and 21), trusted flaggers (Art. 22), Art. 28 minors measures: all exempt for micro and small enterprises (Arts 15(2), 19(1)).
- A cookie banner: we set no cookies, and the `localStorage` we use is strictly necessary (§6).
- An EU legal representative (Art. 13), unless the board says the operator is established outside the EU.

---

## 8. Sources

DSA = Regulation (EU) 2022/2065, https://eur-lex.europa.eu/eli/reg/2022/2065/oj

- DSA, full text: https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32022R2065. Cited: Art. 3(a), (d), (e), (g)(iii), (i), (k); Recital 14; Arts 6, 8, 11 (incl. 11(3)), 12, 13 (incl. 13(5)), 14(1)–(4), 15(2), 16(1)–(6), 17(1)–(3), 18(1)–(2), 19(1), 24(3), 29.
- Directive (EU) 2015/1535 Art. 1(1)(b) (information society service): https://eur-lex.europa.eu/eli/dir/2015/1535/oj
- CJEU C-484/14 *Mc Fadden*, para. 41: https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:62014CJ0484 · C-291/13 *Papasavvas*: https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:62013CJ0291
- Commission Recommendation 2003/361/EC, Annex Arts 1 and 2(3): https://eur-lex.europa.eu/eli/reco/2003/361/oj
- Directive 2000/31/EC (e-Commerce), Arts 2(c), 3, 5(1): https://eur-lex.europa.eu/eli/dir/2000/31/oj
- DDG § 5: https://www.gesetze-im-internet.de/ddg/__5.html
- Medienstaatsvertrag § 18(1)–(2), official consolidated text from the Medienanstalten: https://www.die-medienanstalten.de/fileadmin/user_upload/Rechtsgrundlagen/Gesetze_Staatsvertraege/Medienstaatsvertrag_MStV.pdf ("Anbieter von Telemedien, die nicht ausschließlich persönlichen oder familiären Zwecken dienen, haben … 1. Name und Anschrift sowie 2. bei juristischen Personen auch Name und Anschrift des Vertretungsberechtigten" leicht erkennbar, unmittelbar erreichbar und ständig verfügbar zu halten)
- GDPR, Regulation (EU) 2016/679, Arts 2(2)(c), 6(1), 13(1)–(2): https://eur-lex.europa.eu/eli/reg/2016/679/oj
- ePrivacy Directive 2002/58/EC Art. 5(3): https://eur-lex.europa.eu/eli/dir/2002/58/oj
- Directive (EU) 2019/790 Art. 2(6): https://eur-lex.europa.eu/eli/dir/2019/790/oj
- Directive 2011/93/EU Arts 3–7 (the Art. 16(2)(c) exception): https://eur-lex.europa.eu/eli/dir/2011/93/oj
- CJEU C-466/12 *Svensson*: https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:62012CJ0466 · C-392/19 *VG Bild-Kunst*: https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:62019CJ0392
- GNU AGPL v3 §13: https://www.gnu.org/licenses/agpl-3.0.html#section13
- CC BY-SA 4.0 legal code §3(a): https://creativecommons.org/licenses/by-sa/4.0/legalcode.en
- MIT licence ("The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software."): https://opensource.org/license/mit
- Open Graph protocol: https://ogp.me/
- Google Search Central, robots.txt and `noindex`: https://developers.google.com/search/docs/crawling-indexing/robots/intro and https://developers.google.com/search/docs/crawling-indexing/block-indexing
- Slack, robots.txt and unfurling: https://api.slack.com/robots
- Meta crawler: https://developers.facebook.com/docs/sharing/webmasters/web-crawlers

Repo: ADR 0020, 0028, 0030, 0033; `docs/ops/rooms.md`; `apps/web/privacy.html`; `apps/web/src/report/dialog.ts`; `apps/web/source.ts`; `apps/server/src/http.ts:207-221`; `apps/server/src/static.ts`.
