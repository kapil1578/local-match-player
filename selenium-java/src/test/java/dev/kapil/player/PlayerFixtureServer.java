package dev.kapil.player;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

/** Serves the real UI with synthetic channel data; no media or AI services run. */
final class PlayerFixtureServer implements AutoCloseable {
    private static final String PLAYLIST = """
            #EXTM3U
            #EXTINF:-1 tvg-id="Alpha.us@HD",Alpha Sports (720p)
            https://media.example.com/alpha-hd.m3u8
            #EXTINF:-1 tvg-id="Alpha.us@SD",Alpha Sports (480p)
            https://media.example.com/alpha-sd.m3u8
            #EXTINF:-1 tvg-id="Alpha.us@HD",Alpha Sports (720p)
            https://media.example.com/alpha-hd.m3u8
            #EXTINF:-1 tvg-id="Bravo.uk@HD",Bravo Football (1080p)
            https://media.example.com/bravo.m3u8
            #EXTINF:-1 tvg-id="Archive.in",Archive Sports
            https://media.example.com/archive.mp4
            #EXTINF:-1 tvg-id="Unsafe.us",Unsafe Local
            http://127.0.0.1/private.m3u8
            """;

    private final Path appRoot;
    private final HttpServer server;
    private volatile int playlistStatus = 200;
    private volatile int metadataStatus = 200;
    private volatile String playlist = PLAYLIST;

    PlayerFixtureServer(Path appRoot) throws IOException {
        this.appRoot = appRoot.toRealPath();
        for (String name : new String[] {"index.html", "sports-catalog.js"}) {
            if (!Files.isRegularFile(this.appRoot.resolve(name))) {
                throw new IOException("Missing player source: " + this.appRoot.resolve(name));
            }
        }
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", this::serve);
        server.start();
    }

    String baseUrl() { return "http://127.0.0.1:" + server.getAddress().getPort() + "/"; }
    void failPlaylist() { playlistStatus = 503; }
    void restorePlaylist() { playlistStatus = 200; }
    void emptyPlaylist() { playlist = "#EXTM3U\n"; }
    void failMetadata() { metadataStatus = 503; }

    private void serve(HttpExchange exchange) throws IOException {
        try (exchange) {
            exchange.getResponseHeaders().set("Cache-Control", "no-store");
            // This additional policy intersects with the real page's CSP. It keeps
            // stream/provider URLs inert while allowing the local UI and fixtures.
            exchange.getResponseHeaders().set("Content-Security-Policy",
                    "connect-src 'self'; media-src 'none'; frame-src 'none'");
            if (!"GET".equals(exchange.getRequestMethod())) {
                respond(exchange, 405, "text/plain", "Only GET is supported");
                return;
            }
            String requestPath = exchange.getRequestURI().getPath();
            if ("/sports.m3u".equals(requestPath)) {
                respond(exchange, playlistStatus, "text/plain", playlistStatus == 200 ? playlist : "Unavailable");
            } else if ("/sports-catalog-meta.json".equals(requestPath)) {
                respond(exchange, metadataStatus, "application/json",
                        "{\"source_url\":\"synthetic-test-data\",\"entries\":6,\"channels\":4}");
            } else {
                String name = "/".equals(requestPath) ? "index.html" : requestPath.substring(1);
                // Only top-level web assets are readable: no logs, models, source
                // code, credentials, subdirectories, or arbitrary filesystem paths.
                if (!name.matches("[A-Za-z0-9_-]+\\.(html|js|css)")) {
                    respond(exchange, 404, "application/json", "{\"error\":\"Not part of UI test fixture\"}");
                    return;
                }
                Path asset = appRoot.resolve(name);
                if (!Files.isRegularFile(asset) || !asset.toRealPath().startsWith(appRoot)) {
                    respond(exchange, 404, "text/plain", "Asset not found");
                    return;
                }
                String type = name.endsWith(".js") ? "application/javascript"
                        : name.endsWith(".css") ? "text/css" : "text/html";
                respond(exchange, 200, type, Files.readString(asset, StandardCharsets.UTF_8));
            }
        }
    }

    private static void respond(HttpExchange exchange, int status, String type, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", type + "; charset=utf-8");
        exchange.sendResponseHeaders(status, bytes.length);
        exchange.getResponseBody().write(bytes);
    }

    @Override
    public void close() { server.stop(0); }
}
