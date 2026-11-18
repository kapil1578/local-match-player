# Channel library regression tests

Ten JUnit 5 tests drive headless Chrome through Selenium WebDriver. They exercise the channel library as a user would, selecting channels, changing filters and recovering from failed requests. [Read the test cases](src/test/java/dev/kapil/player/CatalogUiTest.java).

## Run locally

From the repository root on Windows or Linux, with a JDK (17 or later), Maven (3.9 or later) and Chrome installed, run

```sh
mvn -f selenium-java/pom.xml test
```

The first run may download dependencies and a matching ChromeDriver. Each test starts a fresh browser session and a loopback HTTP server on an available port. The server supplies a synthetic playlist with duplicate entries and multiple countries. Individual tests can simulate an empty playlist, a 503 response or unavailable metadata.

## What the suite checks

| Workflow | Expected result |
| --- | --- |
| Browse a playlist with duplicate feeds | Four distinct channels appear, duplicate feed URLs collapse into one option and selecting a channel leaves the video source unset. |
| Search and filter | Mixed-case search matches channel and country names. Combining filters narrows the list. An empty result disables playback, and clearing the search restores the controls. |
| Change channels | Choosing a channel with one feed resets the previous channel's selected feed. |
| Select unusable feeds | Unsupported media formats disable the Watch button. A private-network URL also disables the feed option. |
| Recover from missing data | A playlist error appears on HTTP 503 and clears after a successful reload. An empty playlist disables playback. A missing metadata response still allows channel selection. |

The [page object](src/test/java/dev/kapil/player/CatalogPage.java) uses WebDriver input, native select controls and explicit waits. On failure, the suite saves a screenshot and a DOM snapshot under `target/failure-artifacts`.

## Run evidence

The [original Surefire report](evidence/full-player.txt) records 10 passes against the full local player's HTML and JavaScript with synthetic playlist data. The [showcase report](evidence/public-catalog.txt) records the same ten test methods against the bundled catalog. Both runs took place on 18 November 2026.

The public fixture uses the player's catalog controls and JavaScript with the live feed recommendations removed. It exercises browser behavior up to feed selection. Playback, model inference and Python backend integration are outside its scope.
