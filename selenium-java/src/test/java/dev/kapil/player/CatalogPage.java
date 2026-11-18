package dev.kapil.player;

import java.time.Duration;
import java.util.List;
import java.util.Locale;
import org.openqa.selenium.By;
import org.openqa.selenium.Keys;
import org.openqa.selenium.WebDriver;
import org.openqa.selenium.WebElement;
import org.openqa.selenium.support.ui.ExpectedConditions;
import org.openqa.selenium.support.ui.Select;
import org.openqa.selenium.support.ui.WebDriverWait;

/** Page object: actions use real WebDriver interactions, not DOM mutation. */
final class CatalogPage {
    private final WebDriver driver;
    private final WebDriverWait wait;

    CatalogPage(WebDriver driver) {
        this.driver = driver;
        wait = new WebDriverWait(driver, Duration.ofSeconds(10));
    }

    void open(String baseUrl, String expectedPhase) {
        driver.get(baseUrl);
        wait.until(ExpectedConditions.attributeToBe(By.id("sports-catalog"), "data-sports-catalog", expectedPhase));
        WebElement library = element("channel-library");
        if (library.getDomAttribute("open") == null) {
            driver.findElement(By.cssSelector("#channel-library > summary")).click();
        }
        wait.until(ExpectedConditions.visibilityOfElementLocated(By.id("sports-count")));
    }

    void search(String query) {
        WebElement search = element("sports-search");
        // Native key input exercises the same input event as a user. WebDriver's
        // clear command alone does not reliably emit that event in Chrome.
        search.sendKeys(Keys.chord(Keys.CONTROL, "a"), Keys.BACK_SPACE);
        if (!query.isEmpty()) { search.sendKeys(query); }
    }

    void country(String country) { new Select(element("sports-country")).selectByValue(country); }
    void channel(String id) { new Select(element("sports-channels")).selectByValue("id:" + id.toLowerCase(Locale.ROOT)); }
    void feed(String index) { new Select(element("sports-stream")).selectByValue(index); }
    List<WebElement> channels() { return driver.findElements(By.cssSelector("#sports-channels > option")); }
    List<WebElement> feeds() { return driver.findElements(By.cssSelector("#sports-stream > option")); }
    String selection() { return element("sports-selection").getText(); }
    WebElement element(String id) { return driver.findElement(By.id(id)); }

    void awaitChannelCount(int expected) {
        wait.until(ignored -> channels().size() == expected);
    }

    void awaitSelection(String expected) {
        wait.until(ExpectedConditions.textToBePresentInElementLocated(By.id("sports-selection"), expected));
    }
}
