# Flightpath user guide

Flightpath records your Claude Code sessions on your own computer and shows each one in your browser: what happened, step by step, how the context grew, and what Claude was working with. It also points out a few things that could make your next session cheaper or faster.

This guide covers the plugin as it works today. It assumes you have just installed it. For what Flightpath keeps and what it never keeps, see [Privacy](privacy.md).

- [Install and your first session](#install-and-your-first-session)
- [Sessions](#sessions)
- [Steps](#steps)
- [Tokens](#tokens)
- [Snapshot](#snapshot)
- [Suggestions](#suggestions)
- [Commands](#commands)
- [Settings](#settings)
- [Telemetry (optional)](#telemetry-optional)
- [Troubleshooting](#troubleshooting)
- [Uninstall](#uninstall)
- [Terms](#terms)

## Install and your first session

### What you need

- **Node 24 or later**, on your `PATH`. Run `node --version` to check. A native install of Claude Code doesn't use Node, so you may not have it yet. If it is missing or too old, follow [Install](../packages/flightpath/README.md#install) in the plugin README, or see Troubleshooting below.
- **A current version of Claude Code.** Flightpath 1.0 is tested on Claude Code 2.1.318. To update, run `claude update` in your terminal.

### Install

In Claude Code, run:

```
/plugin marketplace add dk-labs-dev/flightpath
/plugin install flightpath@flightpath
```

### Your first session

Start a new Claude Code session. Flightpath records from your next session, not the one you installed it in.

When a session starts, Flightpath prints one line to say what it is doing. It appears at a fresh start, after `/clear`, and in a forked session. It does not appear when a session is resumed or compacted. These are the lines you can see:

```
● flightpath is recording · /flightpath:status for settings
● flightpath isn't recording this folder · it's in Folders never recorded in Settings
● flightpath is paused · /flightpath:start to record
● flightpath is off · /flightpath:start to turn it on
● flightpath can't start its recorder · /flightpath:status for details
```

The first four say what state this session is in. The last one is a warning, and it always appears when the recorder can't start, even if you have turned the notice off in Settings.

Type `/flightpath:open`. Flightpath starts its local recorder if it isn't running, opens this session's view in your browser, and prints the address:

```
flightpath: opened the live view · http://127.0.0.1:4747/#session/…
```

If no browser can be opened, it prints `flightpath: open this link to see the live view` and the same address, and you open the address yourself. The view is served from your own computer only (`127.0.0.1`). The address carries an access key, so open the view with `/flightpath:open` rather than typing the address. A tab without the key says: "This tab doesn't have Flightpath's access key. Open the view with /flightpath:open, or use the link in /flightpath:status."

### Finding your way around

A side bar on the left has **Now** (the session recording at this moment, or "Nothing recording"), then **Sessions** and **Settings** under **Browse**. At the foot of the side bar, a line says whether the recorder is running, for example "Recorder running · 4747".

Inside a session, three tabs switch between the views described below: **Steps**, **Tokens** and **Snapshot**. Above them, a summary shows the session's title, its state, how long it has run, and its counts of turns, steps and subagents.

## Sessions

The **Sessions** screen lists everything Flightpath has recorded.

**Recording now** shows a card for each live session: its title, its project folder, its state, the turn it is on, how many steps it has run, and its current context size. Select a card to open the session.

**Earlier sessions** lists the rest, grouped by the day each began, newest first. Today's group starts open; other days start shut unless you are searching. Each row shows:

- **Session**: the title. It is the first line of your first prompt, cut at 120 characters. If you turned off "Keep the text of my prompts", or the session has no prompt, it reads "Untitled session".
- **Project**: the name of the folder Claude Code was working in.
- **When**: the start time and how long the session ran.
- **Turns**: how many prompts you sent.
- **Tokens processed**: the tokens across all of the session's requests, counting input, output, cache reads and cache writes.
- **Notes**: short phrases such as "Joined partway" (Flightpath began recording after the session had started), "Imported from transcript", "No telemetry", and "Paused once".

Use the search box ("Search titles and projects") and the **Project** menu to narrow the list. Sessions with nothing in them are left out, and a line under the list says how many. Another line says how many days Flightpath keeps recordings, and links to Settings.

### Live, quiet and ended

A session's state appears on its card, on its row and in the summary:

- **Live**: Flightpath has heard from it recently, or a step is running.
- **Live · quiet since 14:05**: it is live, no step is running, and nothing has been heard for five minutes. The session is still open.
- **Ended 14:32**: the session's own end event arrived.
- **Ended 14:32 · no exit seen**: Flightpath never received an end event, for example because the window was closed. Flightpath ended the session at its last event and says so rather than implying a clean exit. It does this within about a minute when it can see that Claude Code's process has gone, and otherwise after ten minutes without a word from the session.
- **Paused**: you paused recording with `/flightpath:stop`.

A session that was ended this way becomes live again, as the same session, if more events arrive from it.

## Steps

The **Steps** tab is the session's timeline. The first time you see it, a hint reads "Each row is one thing Claude did. Click a row for its details." Select **Dismiss** to hide it.

### Turns and steps

A **turn** is one prompt from you and everything Claude did in answer. A **step** is one thing Claude did during a turn: reading a file, running a command, editing, searching, or running a subagent.

Each turn is a row: "Turn 3", your prompt in quotation marks, and a line of facts such as "4 steps", how long it took, the context before and after it ("context 52.1K → 61.4K"), "1 failure", and "you stepped in". Select a turn to open or fold its steps. Arrow keys move between rows, and Enter opens a step's details.

A subagent's work appears under the step that started it, with its own steps. Rows that Claude Code adds itself are marked "From Claude Code", and a subagent's report back to the main conversation is marked "From a subagent".

At the bottom of a live session you may see "Waiting for you", when Claude is waiting on your answer, or "No new steps for 3 minutes".

### The detail panel

Select a step to open its panel. It opens beside the list, or over it on a phone. At the top is one plain sentence about the step, such as "You asked: …" or the command that ran. Below it:

- A list of facts: for example the command or path, the time, and how long the step took.
- For a step that printed its output elsewhere, a button: "Open the step that printed it".
- A **Request** table for the model request behind the step: the model, **In**, **Out**, **Cache read**, **Cache write** and **Duration**. If a step needed several requests, each has its own table.

A note at the foot says what Flightpath keeps: "Flightpath keeps paths, commands and sizes. File contents and tool output stay in Claude Code."

A step with a suggestion has two tabs in its panel, **Details** and **Suggestions**. See [Suggestions](#suggestions).

### Search, filters and following

Above the list:

- **Search steps** filters the list as you type. Press `/` anywhere on the page to jump to it.
- **You stepped in** shows only the moments you took part in: approving or rejecting a request for permission, stopping a running step, answering a question Claude asked, or running a Claude Code command such as `/model`. The number beside it is the count for the session.
- **Failures** shows only steps that failed, with their count.
- **Follow live** keeps the newest step in view as new steps arrive. It is available only while the session is live.

### The context line

Under the summary, a line chart captioned "Context size per request" shows how big the context was at each request. A dashed line marks the context limit. Small ticks mark moments you spoke ("you"), steps that failed ("failure") and compactions. Select anywhere on the chart to jump to the step at that point, or focus the chart and use the arrow keys.

## Tokens

The **Tokens** tab explains where the context went. Counts are in tokens, never in money.

### Context over time

"Context over time" draws the main conversation's context at each request. Select a point to select its step. The chart also marks:

- **Cache rebuilt**: a diamond where Claude's cache had to be written again. Hover over it for the cause (see [Terms](#terms)).
- **Compactions**: a tick where the context dropped.
- **Idle**: a hatched band for a stretch when you were away for longer than the cache lasts.

Under the chart, a **Subagents** section shows one small line per subagent on the same time axis: the tokens it used, and about how much it returned to the main conversation (an estimate). Claude Code's own background work is counted on one line below.

### Room left

"Room left" shows how much space remains before Claude Code compacts automatically ("tokens to auto-compact") and before the limit itself ("tokens to the limit"). It says where the auto-compact point came from: "your setting", "your /context", or "model default". If the window size looks wrong, the "?" note beside it says: "If this looks wrong, run /context once in Claude Code, and Flightpath reads the exact size from it. Its report goes into the conversation (about 9K tokens), so once is enough."

When there is enough history, it also shows "about N turns at this pace", marked **estimate**, worked out from the median growth of your recent turns.

### Biggest rises

"Biggest rises" lists each time the context grew by more than 2K tokens between requests, largest first, with the first ten shown. A rise opens to show what made it up: your prompt, a tool result, a skill that was loaded, a file or image you attached, or a subagent's report. Sizes marked **measured** are exact. Sizes marked **est.** are estimated from character counts. What Flightpath cannot name is listed as "other (system, tools, history)".

### Turns, in tokens

The last table lists every turn with its **Input**, **Output**, **Cache read**, **Cache write** and **Context change**. Select a column heading to sort by it.

### What "estimate" means

Totals come from the usage figures Claude Code records. Where Flightpath only knows a size in characters, it divides by about 2.9 characters per token and tags the result as an estimate, so it is close but not exact.

## Snapshot

The **Snapshot** tab shows what Claude had in its context at one step.

By default it shows the latest step. Select **Pick another step** to choose a different one, or select a step in the Steps tab first. For a step inside a subagent, it says "inside the subagent" and names it.

The tab has three parts:

- **In context at this step**: the measured context size against the limit, then a line such as "Named: about 31.2K of 52,000 measured (60%)". "Named" is how much of the context Flightpath can put a name to.
- **Sent on every request**, "before any work": the system prompt, the tools (largest first; **Show all** reveals the rest), each MCP server with its tool count, your CLAUDE.md files, and whatever Claude Code adds at the start of a session, such as the skills listing and the names of tools loaded on demand. These sizes are estimates.
- **What the agent had been given**: everything else, in groups, largest first: your prompts, images and files, skills, command output, files read, tool results, subagent results and Claude's replies. Anything Flightpath can't name is "Other (history Flightpath can't name)".

After a compaction, the tab also shows what Claude Code restored and what the conversation held before it.

For the categories Claude Code itself reports at this moment, run `/context` in Claude Code.

## Suggestions

Flightpath reviews a session as it runs and may suggest a change. A suggestion never changes anything for you. Each one says "could", because Flightpath can't know that a change would have saved anything.

### Grades

Each suggestion has one of three grades, shown with a shape as well as a colour:

- **Worth fixing** (filled circle)
- **Worth a look** (ring)
- **Did you know** (square)

They are listed most important first.

### Where they appear

- A step with a suggestion shows the grade's shape beside it in the Steps tab. Select the step and open the **Suggestions** tab in its panel.
- Above the list of steps, a collapsed line lists all of the session's suggestions. Open it to read them. Each card there has **Show in steps**, which takes you to the step.

### On each card

- The grade and a one-line headline.
- A short explanation.
- Sometimes a list (the files or skills concerned).
- A link to the Claude Code documentation page that explains the cause. It opens in a new tab.
- **Copy**, when there is text to paste, such as deny rules. The button reads "Copied" for two seconds.
- **Dismiss**. A dismissed suggestion stays dismissed after you reload.

### What each kind means

The first four kinds are about cache rebuilds. Flightpath reports one only when the request wrote about 5K tokens or more to the cache again, so a small session stays quiet.

**Compact before a long break.** The cache had expired after a break, so the next message wrote the conversation again. Shown as Worth a look the first time in a session and Worth fixing when it happens again. Fix: run `/compact` before stepping away, or start a fresh session if you aren't coming back to the work.

**Pick your model at the start of a session.** Switching models in the middle of a session can't reuse the cache, so the conversation is written again. Worth a look. Fix: choose the model before the first message.

**Set effort at the start of a session.** Changing the effort level on some models starts the cache over. Worth a look. Flightpath reports this only for models where it knows a change has that effect. Fix: choose the effort level before the first message.

**Add or remove tool servers at the start of a session.** Changing the list of tools, for example by connecting or removing an MCP server, started the cache over. Worth a look. The card names the servers that changed. Fix: connect the servers you need before the first message.

**Trim the files Claude reads at the start of every session.** Your always-loaded instruction files (such as CLAUDE.md) add up to 5K tokens or more, and they are sent with every request. Worth a look. The card lists the largest files. Fix: move parts that are rarely needed into skills, which load only when used.

**Turn off skills you don't use.** Claude Code lists every available skill on every request. If some were never used in a session of at least 10 turns, or in one that has ended, this says how many and how much the listing costs. Did you know. Fix: turn off the skills you don't need. In Claude Code, `/skill-doctor` shows each skill's cost and use.

**Block reads of …** (the headline names what was read, such as `node_modules` or lockfiles). Claude read folders or files that are rarely worth the space, such as `node_modules`, `dist`, lockfiles or minified files, and no deny rule covers them. Worth a look from 5K tokens read, and Worth fixing from 25K. The card lists them and has a **Copy** button with the rules, for example `"Read(**/node_modules/**)"`. Fix: paste them into the `deny` list under `permissions` in a Claude Code settings file. A Read deny rule also blocks edits and writes in those places.

Flightpath only suggests a rule if none of your settings files already names the place. When it can't tell, it says nothing.

### In the terminal

When a turn produced a suggestion graded Worth fixing or Worth a look, one line appears under Claude's reply:

`● flightpath has 1 suggestion worth a look from this turn · /flightpath:open to see it`

With one suggestion it says "worth fixing" or "worth a look". With several it counts them, for example `● flightpath has 3 suggestions from this turn, 1 worth fixing · /flightpath:open to see them`, or "all worth a look" when none is worth fixing. Claude Code may put "Stop says:" in front of the line.

- The line is shown to you only. It never reaches Claude and costs no tokens.
- Suggestions about the whole session, and Did you know, appear only in the browser.
- After each reply, Claude Code waits for Flightpath to check the turn. That is a short pause, usually under half a second.
- Nothing is printed while recording is paused or off, or in a folder you have excluded.
- To turn the line off, switch off **Show a note after a turn** in Settings. See [Recording](#recording).

### Rebuild causes on the Tokens chart

Every cache rebuild on the Tokens chart names its cause when Flightpath can tell: a compaction (which is expected), the cache expiring after a break, a change of model, a change of effort, or a change to the tools sent to Claude. Otherwise it says the cause is unknown. A compaction or an unknown cause gets no suggestion.

### The cache note

When the cache is about to expire in a live session, a note appears in the summary: "Cache warm for about 2 more minutes", followed by "After that, your next message could write about 40.2K again." Once it has expired it reads "Cache expired". The note appears only for the last two minutes of a five-minute cache and the last ten minutes of a one-hour cache, and not while a step is running.

## Share

The **Share** button in the top bar of a session makes an image of that session's numbers: your prompts, what Claude Code was carrying, the biggest jump and its kind of cause, with the session's length and step count. Save it or copy it and post it where you like. The card carries only those numbers and the fixed labels — never file names, paths or prompt text — and nothing leaves your computer unless you post the image yourself.

## Commands

Six commands. Each is answered on your own computer and never reaches Claude, so they cost no tokens.

Claude Code prints a command's answer under the heading "UserPromptExpansion operation blocked by hook". That is expected, not an error: Flightpath answers the command itself and stops it there, which is what keeps it from reaching Claude.

- `/flightpath:open`: open this session's view in your browser.
- `/flightpath:status`: show whether this session is recording, paused, or off everywhere; the recorder's address; the data folder; any buffered events; the last start error and a next step, if there was one; how many days recordings are kept; the database size; what is capturing this session; and the tokens Flightpath's own commands used in it. While the recorder runs it also gives the link to Settings.
- `/flightpath:stop`: pause recording for this session. A paused stretch is not filled in afterwards.
- `/flightpath:start`: resume recording for this session. If you turned Flightpath off with `/flightpath:off`, this turns it back on everywhere.
- `/flightpath:off`: stop recording in all sessions and stop the recorder.
- `/flightpath:forget`: delete this session's recording, and pause it so nothing new is captured.

Arguments after a command are ignored.

## Settings

Open **Settings** from the side bar, or from the link in `/flightpath:status`. Changes take effect when you save them, and the screen says "Saved. New sessions use these settings." Everything on the screen stays on your computer.

### Recording

- **Record new sessions automatically** (on by default): when off, a session records only after you run `/flightpath:start` in it.
- **Show the startup notice** (on by default): the one line at session start that says whether Flightpath is recording. Problems are always shown.
- **Show a note after a turn** (on by default): one line under Claude's reply when the turn has a suggestion worth a look. Nothing is shown otherwise. Each reply is followed by a short pause, usually under half a second, while Flightpath checks the turn. See [In the terminal](#in-the-terminal).
- **Keep the text of my prompts** (on by default): Flightpath keeps the first 2,000 characters of each prompt you type, so Steps can show what you asked. When off, only the prompt's length is kept. See below.
- **Folders never recorded**: one full folder path per line. Sessions working in these folders are skipped, as if paused.

### Your data

- **Keep recordings for**: 7, 15, 30, 60 or 90 days (15 by default). Older recordings are deleted automatically and the space is given back. A session still in progress is never deleted. If you lower the period, Flightpath tells you how many sessions will be deleted now and asks you to confirm.
- **Danger zone, Delete all data**: deletes every recording on this computer. Your settings stay. You must type DELETE to confirm, and it can't be undone.

### Advanced settings

- **Port** (4747 by default): the port the recorder listens on, on this computer only. If it is taken, the recorder tries the next free port above it, up to 20 times. Saving a new port restarts the recorder on it.
- **Stop the recorder after**: 5, 15, 30 or 60 minutes with no activity (30 by default), or once a running session's cache has gone cold if that is later, at most about an hour. The next session starts the recorder again.

### Your prompts

Prompt text is kept by default, and Flightpath doesn't ask first. What it does:

- It keeps the first 2,000 characters of each prompt you type, with the prompt's full length and line count. Longer prompts are cut at 2,000 characters. The cut applies to every stored copy of the prompt: the session's turn and the raw record of the event.
- A slash command's arguments are kept the same way, up to 2,000 characters, whether or not prompt text is kept.
- Known secret patterns are removed before anything is written to disk. A secret in a shape Flightpath doesn't know is not caught.
- Turning off "Keep the text of my prompts" applies to new prompts. From then on, only the length is kept.
- Text kept earlier is hidden, not deleted: Steps, the session titles and the Tokens table stop showing it, but it stays in the database. `/flightpath:forget` deletes a session's recording, and Delete all data deletes every recording, and either one removes the text with it.

Commands Claude runs are kept in full, apart from known secret patterns, and file contents, tool output and Claude's replies never are. [Privacy](privacy.md) lists everything Flightpath keeps and where.

## Telemetry (optional)

Without telemetry, Flightpath still records the full journey and the token counts for your own requests and your subagents'. Claude Code's telemetry adds what the transcripts don't hold: background requests (titles, suggestions, compaction), who approved each action, and exact timings. Sessions recorded without it say "No telemetry" in their notes, and the Tokens tab says that totals cover your own requests only.

It is off until you turn it on. In Settings, under **Claude Code telemetry**, select **Turn on…**. Flightpath explains first and asks you to confirm. Then it adds telemetry settings to your Claude Code settings file (`~/.claude/settings.json`) so that Claude Code sends its telemetry to your own computer. It never leaves the machine, and account identity is dropped. It applies from your next session. **Turn off…** removes exactly what was added.

If telemetry is already configured elsewhere, the screen says so ("Set up elsewhere") and changes nothing. The check reads your environment, your settings file and managed settings files. It can't see policy delivered by your operating system or an organization console.

## Troubleshooting

### Node is too old

When a session starts, Flightpath prints:

```
● flightpath needs Node 24 or later; this is Node 20.11.0 · see Install in the README
```

The version at the end is the one Flightpath found. Until you update, Flightpath records nothing.

1. In a terminal, run `node --version`.
2. If it is lower than 24, install Node 24 or later: follow [Install](../packages/flightpath/README.md#install) in the plugin README.
3. Restart Claude Code, from a terminal. A Claude Code started from a desktop app or an editor may not see a Node installed with nvm.

### Node is missing

With no Node on your `PATH`, there is nothing to run Flightpath's hooks, so nothing is recorded and Flightpath prints nothing of its own. Instead Claude Code shows its own hook error, worded like this:

```
SessionStart:startup hook error
Failed with non-blocking status code: Error occurred while executing hook command: Executable not found in $PATH: "node"
```

The same error can appear on other events while Node is missing, and Claude Code keeps working, but nothing is recorded.

The `/flightpath:` commands need Node too, so they won't work either.

1. In a terminal, run `node --version`. If it says the command isn't found, Node is missing.
2. Install Node 24 or later: follow [Install](../packages/flightpath/README.md#install) in the plugin README.
3. Restart Claude Code, from a terminal.

### Nothing is recording and Claude Code shows hook errors

First update Claude Code: run `claude update` in your terminal, then start a new session. If the errors continue, check Node as described above.

### The recorder won't start

You see "Flightpath can't start its recorder" at session start or at the top of the view. Run `/flightpath:status`. It answers without the recorder, and shows a line such as `last start error: …` and, for common causes, `next step: …`.

- **Port in use.** A taken port is normally not a failure, because the recorder moves up to the next free one. It fails only when none of those ports can be used. The view then says "Port 4747 is in use by another program, and the recorder couldn't bind it at 14:05." Close the other program, or choose another port under Advanced settings in Settings (the banner's **Change the port** link goes there). New sessions pick up the new port by themselves.
- **Database.** The view says "The recorder couldn't open its database at 14:05." Check that the database file, which the message names, isn't damaged and isn't held open by another program.

While the recorder is down, events wait on your computer ("N events are waiting on this machine … Nothing is lost yet") and are stored as soon as it starts. If too many pile up, further events are dropped and the view says so; the sessions' transcripts still cover them.

The recorder also stops by itself after the idle time in Settings. The view then says "The recorder isn't running, so nothing new is being recorded." Starting a Claude Code session starts it again. If you turned off "Record new sessions automatically", run `/flightpath:start` in the session as well. After `/flightpath:off`, `/flightpath:start` is what turns recording back on.

### A session says "no exit seen"

Flightpath didn't receive the session's end event, usually because the window was closed or Claude Code was stopped. Nothing is lost: it ended the session at its last event. See [Live, quiet and ended](#live-quiet-and-ended).

### The cache note doesn't appear

The note shows only near the end of the cache's life, and only while a session is live with no step running. Flightpath takes the cache's lifetime from the last request that wrote to the cache. On a one-hour cache the note starts ten minutes before the hour is up, so for most of the hour there is nothing to show. On a five-minute cache it starts two minutes before the end. If no request in the session has written to the cache, there is no note. After a compaction there is none either, until the next request.

## Uninstall

In Claude Code:

```
/plugin uninstall flightpath@flightpath
/plugin marketplace remove flightpath
```

To stop the recorder at once, run `/flightpath:off` first. Otherwise it stops by itself after the idle time in Settings.

Uninstalling removes the plugin but not your recordings. They stay in Flightpath's own folder, and reinstalling picks them up again:

- Windows: `%LOCALAPPDATA%\Flightpath`
- macOS: `~/Library/Application Support/Flightpath`
- Linux: `$XDG_DATA_HOME/flightpath`, or `~/.local/share/flightpath`

To delete them, use **Delete all data** in Settings before you uninstall, or delete that folder afterwards. The folder also holds your Flightpath settings.

## Terms

**Cache.** Claude Code re-sends the whole conversation with every request, and the API reuses the start of it that it has recently processed instead of processing it again. A **cache hit** (the **Cache read** columns) is the part served from the cache. A **cache write** is the part stored for next time.

**Cache lifetime.** A cached start expires after a period of inactivity, and each request that hits the cache resets the timer. There are two lifetimes: **five minutes** and **one hour**. Which one a request gets depends on how you sign in and on your Claude Code settings.

**Cache rebuild.** A request that had to write more than half of its context to the cache again, after the request before it had read from the cache. Flightpath marks each one with a diamond and names the cause when it can.

**Compaction (auto-compact).** Claude Code summarised the conversation to free up room in the context. It happens when you run `/compact`, and automatically as the context nears its limit.

**Context.** Everything Claude is holding in mind for the next request: instructions, the conversation so far, and tool results.

**Context window.** The space Claude has for its context. Flightpath shows its size as the limit.

**Estimate (est.).** Worked out from the number of characters, at about 2.9 per token. Close, not exact.

**Measured.** This result arrived on its own, so its size is exact: how much the context grew, minus Claude's reply.

**MCP server.** A program that gives Claude Code access to extra tools, databases or services, through the Model Context Protocol.

**Named.** How much of the context Flightpath can put a name to. The rest is listed as Other.

**Other.** The part of the context Flightpath can't name, mostly earlier conversation.

**Sent on every request.** What Claude Code sends with every request before any work: its instructions, tool descriptions, CLAUDE.md and the skills list.

**Skill.** A set of instructions that extends what Claude can do. Claude sees each skill's short description all the time, and loads the whole skill only when it is used.

**Start-up files.** The files Claude reads at the start of a session and carries on every request, mainly your CLAUDE.md files.

**Step.** One thing Claude did during a turn: a tool call, a command or a subagent run.

**Subagent.** A helper that Claude starts for a side task. It works in its own context window and returns only a summary to the main conversation.

**Tokens.** The unit Flightpath counts context and usage in. It counts tokens, not money.

**Turn.** One prompt from you, and everything Claude did in answer.
