# Flightpath

Live session insight and coaching for Claude Code. This is the plugin; the [project README](https://github.com/dk-labs-dev/flightpath#readme) says what it does and shows the views.

## Install

You need **Node 24 or later** on your `PATH`. Claude Code doesn't need Node itself, so check with `node --version`. If it's missing or older, install it with [nvm](https://github.com/nvm-sh/nvm) on macOS and Linux (`nvm install 24`), [nvm-windows](https://github.com/coreybutler/nvm-windows) on Windows, or directly from [nodejs.org](https://nodejs.org). If you start Claude Code from a desktop app or an IDE, it may not see a Node installed through nvm; starting it from a terminal avoids that.

Flightpath also needs a current Claude Code. Version 1.0 is tested on Claude Code 2.1.318.

Then, in Claude Code:

```
/plugin marketplace add dk-labs-dev/flightpath
/plugin install flightpath@flightpath
```

Recording starts with your next session. Type `/flightpath:open` to see it.

## Learn more

The [user guide](https://github.com/dk-labs-dev/flightpath/blob/main/docs/guide.md) covers each view, the suggestions and the settings.
