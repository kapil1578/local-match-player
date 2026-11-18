package dev.kapil.player;

import static org.junit.jupiter.api.Assertions.*;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.AfterTestExecutionCallback;
import org.junit.jupiter.api.extension.RegisterExtension;
import org.openqa.selenium.BuildInfo;
import org.openqa.selenium.OutputType;
import org.openqa.selenium.WebDriverException;
import org.openqa.selenium.chrome.ChromeDriver;
import org.openqa.selenium.chrome.ChromeOptions;

class CatalogUiTest {
    private PlayerFixtureServer server;
    private ChromeDriver driver;
    private CatalogPage page;

    @RegisterExtension
    final AfterTestExecutionCallback failureArtifacts = context -> {
        if (driver != null && context.getExecutionException().isPresent()) {
            try {
                Path folder = Path.of("target", "failure-artifacts");
                Files.createDirectories(folder);
                String name = context.getRequiredTestMethod().getName();
                Files.write(folder.resolve(name + ".png"), driver.getScreenshotAs(OutputType.BYTES));
                Files.writeString(folder.resolve(name + ".html"), driver.getPageSource(), StandardCharsets.UTF_8);
            } catch (IOException | WebDriverException error) {
                context.getExecutionException().orElseThrow().addSuppressed(error);
                System.err.println("Unable to save failure artifacts: " + error);
            }
        }
    };

    @BeforeEach
    void setUp() throws IOException {
        server = new PlayerFixtureServer(Path.of(System.getProperty("player.root")));
        ChromeOptions options = new ChromeOptions();
        options.addArguments("--headless=new", "--window-size=1440,1100", "--disable-background-networking");
        driver = new ChromeDriver(options);
        driver.manage().timeouts().pageLoadTimeout(Duration.ofSeconds(20));
        page = new CatalogPage(driver);
        Files.createDirectories(Path.of("target"));
        Files.writeString(Path.of("target", "environment.txt"),
                "Java: " + System.getProperty("java.version") + "\nSelenium: " + new BuildInfo().getReleaseLabel()
                + "\nChrome: " + driver.getCapabilities().getBrowserVersion() + "\n", StandardCharsets.UTF_8);
    }

    @AfterEach
    void tearDown() {
        try {
            if (driver != null) { driver.quit(); }
        } finally {
            if (server != null) { server.close(); }
        }
    }

    @Test
    void groupsDuplicateEntriesWithoutAutomaticallyStartingPlayback() {
        page.open(server.baseUrl(), "ready");
        assertEquals(4, page.channels().size());
        page.channel("Alpha.us");
        assertEquals(2, page.feeds().size(), "Duplicate stream URLs must be merged");
        assertTrue(page.element("sports-watch").isEnabled());
        assertNull(page.element("video").getDomAttribute("src"));
        assertNull(page.element("sports-catalog").getDomAttribute("aria-busy"));
    }

    @Test
    void searchesCaseInsensitivelyAcrossNameAndCountry() {
        page.open(server.baseUrl(), "ready");
        page.search("bRaVo UNITED");
        page.awaitChannelCount(1);
        assertTrue(page.channels().get(0).getText().contains("Bravo Football"));
    }

    @Test
    void combinesCountryAndTextFilters() {
        page.open(server.baseUrl(), "ready");
        page.country("US");
        page.awaitChannelCount(2);
        page.search("alpha");
        page.awaitChannelCount(1);
        assertTrue(page.channels().get(0).getText().contains("Alpha Sports"));
        page.country("UK");
        page.awaitChannelCount(0);
        assertFalse(page.element("sports-watch").isEnabled());
    }

    @Test
    void recoversAfterAnEmptySearchResult() {
        page.open(server.baseUrl(), "ready");
        page.search("no-such-channel-987");
        page.awaitChannelCount(0);
        assertFalse(page.element("sports-channels").isEnabled());
        assertFalse(page.element("sports-stream").isEnabled());
        assertFalse(page.element("sports-watch").isEnabled());
        assertTrue(page.selection().contains("No channels match"));
        page.search("");
        page.awaitChannelCount(4);
        assertTrue(page.element("sports-channels").isEnabled());
        assertTrue(page.element("sports-watch").isEnabled());
    }

    @Test
    void resetsFeedSelectionWhenSwitchingChannels() {
        page.open(server.baseUrl(), "ready");
        page.channel("Alpha.us");
        page.feed("1");
        page.awaitSelection("source 2 of 2");
        page.channel("Bravo.uk");
        page.awaitSelection("Bravo Football");
        assertEquals(1, page.feeds().size());
        assertEquals("0", page.element("sports-stream").getDomProperty("value"));
        assertTrue(page.selection().contains("source 1 of 1"));
    }

    @Test
    void disablesPlaybackForUnsupportedMediaFormats() {
        page.open(server.baseUrl(), "ready");
        page.channel("Archive.in");
        page.awaitSelection("not identified as HLS");
        assertFalse(page.element("sports-watch").isEnabled());
        assertTrue(page.feeds().get(0).isEnabled(), "Unsupported format remains visible for explanation");
    }

    @Test
    void preventsSelectingPrivateNetworkStreamUrls() {
        page.open(server.baseUrl(), "ready");
        page.channel("Unsafe.us");
        page.awaitSelection("private, local or reserved IPv4 address");
        assertFalse(page.element("sports-watch").isEnabled());
        assertFalse(page.feeds().get(0).isEnabled());
    }

    @Test
    void reportsPlaylistHttpFailureAndRecoversOnReload() {
        server.failPlaylist();
        page.open(server.baseUrl(), "error");
        assertTrue(page.element("sports-error").isDisplayed());
        assertTrue(page.element("sports-error").getText().contains("HTTP 503"));
        assertFalse(page.element("sports-watch").isEnabled());
        assertFalse(page.element("sports-search").isEnabled());
        server.restorePlaylist();
        page.open(server.baseUrl(), "ready");
        assertFalse(page.element("sports-error").isDisplayed());
        assertEquals(4, page.channels().size());
    }

    @Test
    void reportsAnEmptyPlaylistWithoutLeavingStaleControlsEnabled() {
        server.emptyPlaylist();
        page.open(server.baseUrl(), "error");
        assertTrue(page.element("sports-error").getText().contains("no channel entries"));
        assertEquals(0, page.channels().size());
        assertFalse(page.element("sports-watch").isEnabled());
    }

    @Test
    void keepsCatalogUsableWhenOptionalMetadataIsUnavailable() {
        server.failMetadata();
        page.open(server.baseUrl(), "ready");
        assertEquals(4, page.channels().size());
        assertTrue(page.element("sports-loaded").getText().contains("metadata unavailable"));
        assertTrue(page.element("sports-watch").isEnabled());
    }
}
