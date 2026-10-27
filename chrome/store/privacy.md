# Kokoro Speak for Chrome: privacy policy

Kokoro Speak reads text aloud using a speech model that runs on your own
computer. It has no servers, collects no analytics, and doesn't require an
account.

**Text you have read aloud** is processed on your device and isn't stored or
sent anywhere, with one exception that you control: if you turn on **AI
rewriting** in the options and enter your own Anthropic API key, the sentences
that contain numbers or symbols are sent to Anthropic's API, as they're
about to be read, so they can be rewritten to sound right ("$10B" as "10
billion dollars"). Anthropic handles that text under its own terms and
privacy policy (https://www.anthropic.com/legal/privacy). AI rewriting is off
by default.

**Your settings** (voice, speed, pronunciations) are saved with Chrome's
extension storage. If you're signed in to Chrome with sync on, Chrome syncs
them between your devices.

**Your API key**, if you enter one, is stored only on this device, in the
extension's local storage, and is sent only to api.anthropic.com.

**Page access.** The extension reads a page only when you ask it to (the
right-click menu, a keyboard shortcut or the toolbar popup), and only that
page, to get the text to read and to highlight the sentence being spoken. If
you select text inside a frame embedded from another site, the popup can ask
Chrome for access to that one site, so it can read and highlight the text
there; you can remove that access at any time in the extension's details in
chrome://extensions.

Kokoro Speak doesn't sell or share data, and doesn't use it for advertising
or anything other than reading text aloud.
