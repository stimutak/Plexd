-- Plexd Chrome App
-- Auto-starts Node.js server if not running, launches Chrome with persistent profile and extension

on run
    set projectDir to POSIX path of ((path to home folder as text) & "Projects:Plexd:")
    set serverPort to 8080
    set debugPort to 9222
    set chromeProfile to projectDir & ".chrome-profile"
    set extensionDir to projectDir & "extension"
    set serverScript to projectDir & "scripts/start-server.sh"
    set plexdURL to "http://localhost:" & serverPort & "/?autoload=last"
    set chromeBin to "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

    -- Start server if not running
    try
        do shell script "curl -s --max-time 2 http://localhost:" & serverPort & "/ > /dev/null 2>&1"
    on error
        -- Server not running, start it
        do shell script serverScript & " > /dev/null 2>&1"
        -- Wait for server
        repeat 20 times
            try
                do shell script "curl -s --max-time 1 http://localhost:" & serverPort & "/ > /dev/null 2>&1"
                exit repeat
            on error
                delay 0.5
            end try
        end repeat
    end try

    -- Kill any existing Chrome using our profile so --load-extension works on relaunch
    try
        do shell script "lsof -ti :" & debugPort & " | xargs kill 2>/dev/null || true"
        delay 1
    end try

    -- Launch Chrome directly so --load-extension is respected
    do shell script quoted form of chromeBin & ¬
        " --remote-debugging-port=" & debugPort & ¬
        " --user-data-dir=" & quoted form of chromeProfile & ¬
        " --load-extension=" & quoted form of extensionDir & ¬
        " --no-first-run" & ¬
        " --disable-default-apps" & ¬
        " --disable-popup-blocking" & ¬
        " --start-maximized" & ¬
        " " & quoted form of plexdURL & " &> /dev/null &"
end run
