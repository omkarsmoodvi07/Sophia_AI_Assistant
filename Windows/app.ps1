<#
    app.ps1 - Sophia's hands on Windows.

    She already has a shell on this machine through the Remote Runtime, so files,
    folders and launching programs are solved. What a shell cannot do is reach
    *inside* a running application: click the Send button, read the list of chats,
    put text in the message box. That is what this script is for.

    It works on any application, not a specific one. Windows exposes every app's
    controls through UI Automation - the same mechanism screen readers use - so
    buttons, lists and text boxes are readable and clickable by name in WhatsApp,
    Notepad, Chrome, Excel, Spotify, Settings, anything.

    The important command is `inspect`. Nothing here hard-codes what an app looks
    like, because that would break the moment the app updated. Instead she looks
    at the app's real control tree, sees what is actually there, and acts on what
    she found.

    USAGE - always through Windows PowerShell 5.1, which always has UI Automation:

      powershell -NoProfile -ExecutionPolicy Bypass -File app.ps1 <command> [args]

    FINDING THINGS
      apps [filter]              installed applications and their launch IDs
      open <name>                launch an app by its Start menu name
      windows                    every open top-level window right now
      focus <title>              bring a window to the front
      inspect <title> [depth] [max]
                                 dump a window's control tree: what is in it,
                                 what it is called, and what can be done to it
      read <title>               all readable text in a window

    DOING THINGS
      click <title> <element>    click a button, list row, checkbox, tab
      settext <title> <element> <text>
                                 put text into a specific text box
      type <text>                type into whatever has focus right now
      keys <combo>               raw keystrokes: ^s = Ctrl+S, % = Alt,
                                 + = Shift, {ENTER}, {TAB}, {ESC}, {F5}
      close <title>              ask a window to close

    <title> and <element> are case-insensitive partial matches, so "whats" finds
    "WhatsApp" and "send" finds the Send button.

    ON SAFETY
    Reading is harmless; clicking is not. A sensible split for the Must review
    deny list under Shell command, so looking is instant and acting asks first:

        *app.ps1 click*
        *app.ps1 keys*
        *app.ps1 close*

    Leave `settext` and `type` off that list if you want her to draft messages
    without interruption - putting text in a box sends nothing by itself, because
    Enter is a `keys` call, and that is the one that asks.
#>

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string] $Command = 'help',

    [Parameter(Position = 1, ValueFromRemainingArguments = $true)]
    [string[]] $Rest = @()
)

# Not 'Stop': one unreadable element in a tree of four hundred must not end the
# whole walk. Risky calls are wrapped individually instead.
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

# How much of a control tree to look at before giving up. A browser or a chat app
# can hold tens of thousands of elements; walking all of them takes minutes and
# returns nothing useful. These caps keep every call quick. Pass larger ones to
# `inspect` when a specific control really is deeper than this.
$script:MaxDepth = 6
$script:MaxElements = 400
$script:TimeoutSeconds = 20
$script:Watch = [System.Diagnostics.Stopwatch]::StartNew()

# Shared state for the tree walk. Deliberately script-scoped: the visitor
# scriptblock runs inside the recursion, and script scope is the only way to
# collect results out of it that is obvious to read.
$script:Visited = 0
$script:Hits = @()
$script:Seen = $null
$script:Needle = ''
$script:RequireAction = $false

# ---------------------------------------------------------------- output helpers

# Sophia reads stdout. A failure she cannot see is a failure she will confidently
# report as success, so errors go to both streams and always start with ERROR.
function Fail([string] $Message) {
    Write-Output "ERROR $Message"
    [Console]::Error.WriteLine("ERROR $Message")
    exit 1
}

function Note([string] $Message) {
    Write-Output $Message
}

# ---------------------------------------------------------------- UI Automation

function Initialize-Automation {
    try {
        Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
        Add-Type -AssemblyName UIAutomationTypes -ErrorAction Stop
        Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
    }
    catch {
        Fail ('cannot load UI Automation: ' + $_.Exception.Message +
              '. Run this with Windows PowerShell (powershell.exe), not pwsh.exe.')
    }

    # Used only as fallbacks: restoring a minimised window, and clicking by screen
    # position when a control exposes no clickable pattern.
    if (-not ('SophiaWin' -as [type])) {
        $source = @'
using System;
using System.Runtime.InteropServices;
public class SophiaWin {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, uint extra);
    public const int SW_RESTORE = 9;
    public static void Click(int x, int y) {
        SetCursorPos(x, y);
        mouse_event(0x0002, 0, 0, 0, 0);
        mouse_event(0x0004, 0, 0, 0, 0);
    }
}
'@
        try { Add-Type -TypeDefinition $source -ErrorAction Stop } catch { }
    }
}

# Every property read below is wrapped. An element can disappear between being
# found and being asked about itself - the app repainted, a list scrolled - and
# that throws rather than returning null.
function Get-ElName($element) {
    try { $value = $element.Current.Name } catch { return '' }
    if ($null -eq $value) { return '' }
    return [string]$value
}

function Get-ElType($element) {
    try { $value = $element.Current.ControlType.ProgrammaticName } catch { return '?' }
    if ($null -eq $value) { return '?' }
    return ([string]$value) -replace '^ControlType\.', ''
}

function Get-ElId($element) {
    try { $value = $element.Current.AutomationId } catch { return '' }
    if ($null -eq $value) { return '' }
    return [string]$value
}

function Get-ElValue($element) {
    $pattern = $null
    try {
        if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
            $value = $pattern.Current.Value
            if ($null -ne $value) { return [string]$value }
        }
    }
    catch { }
    return ''
}

function Get-ElOffscreen($element) {
    try { return [bool]$element.Current.IsOffscreen } catch { return $false }
}

# What can actually be done to this element. Reported by `inspect` so she can tell
# a real button from a label that merely looks like one.
function Get-ElActions($element) {
    $actions = @()
    $probe = $null
    try { if ($element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern,         [ref]$probe)) { $actions += 'click' } }   catch { }
    try { if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,          [ref]$probe)) { $actions += 'settext' } } catch { }
    try { if ($element.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern,         [ref]$probe)) { $actions += 'toggle' } }  catch { }
    try { if ($element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern,  [ref]$probe)) { $actions += 'select' } }  catch { }
    try { if ($element.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$probe)) { $actions += 'expand' } }  catch { }
    if ($actions.Count -eq 0) { return '-' }
    return ($actions -join ',')
}

function Test-BudgetExhausted {
    return ($script:Watch.Elapsed.TotalSeconds -gt $script:TimeoutSeconds)
}

# ---------------------------------------------------------------- window lookup

function Get-TopLevelWindows {
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    if ($null -eq $root) { Fail 'no desktop root element; is a user actually logged in on this machine?' }
    try {
        return $root.FindAll(
            [System.Windows.Automation.TreeScope]::Children,
            [System.Windows.Automation.Condition]::TrueCondition)
    }
    catch {
        Fail ('cannot enumerate windows: ' + $_.Exception.Message)
    }
}

# Substring match on the window title, then on the process name, so both
# "whatsapp" and "notepad" land whichever the app calls itself.
function Find-Window([string] $Title) {
    if ([string]::IsNullOrWhiteSpace($Title)) { Fail 'no window title given' }
    $needle = $Title.Trim().ToLowerInvariant()
    $hits = @()

    foreach ($window in Get-TopLevelWindows) {
        $name = Get-ElName $window
        if ($name.ToLowerInvariant().Contains($needle)) { $hits += $window; continue }
        try {
            $process = Get-Process -Id $window.Current.ProcessId -ErrorAction SilentlyContinue
            if ($null -ne $process -and $process.ProcessName.ToLowerInvariant().Contains($needle)) {
                $hits += $window
            }
        }
        catch { }
    }

    if ($hits.Count -eq 0) {
        Fail ("no open window matching '" + $Title + "'. Run 'windows' to see what is open, " +
              "or 'open " + $Title + "' to start it.")
    }
    if ($hits.Count -gt 1) {
        $names = @()
        foreach ($hit in $hits) { $names += ("'" + (Get-ElName $hit) + "'") }
        Note ('NOTE ' + $hits.Count + ' windows matched (' + ($names -join ', ') + '); using the first.')
    }
    return $hits[0]
}

function Set-WindowFocus($window) {
    try {
        $handle = [IntPtr]$window.Current.NativeWindowHandle
        if ($handle -ne [IntPtr]::Zero -and ('SophiaWin' -as [type])) {
            # A minimised window has no usable clickable points until it is back on
            # screen, so restore before raising.
            [SophiaWin]::ShowWindow($handle, [SophiaWin]::SW_RESTORE) | Out-Null
            [SophiaWin]::SetForegroundWindow($handle) | Out-Null
        }
    }
    catch { }
    try { $window.SetFocus() } catch { }
    Start-Sleep -Milliseconds 350
}

# ---------------------------------------------------------------- the tree walk

# Depth-first and bounded, using TreeWalker rather than FindAll. FindAll on a chat
# app's root materialises the entire tree in one call and can take minutes;
# TreeWalker is what lets the depth cap and the timeout actually take effect.
function Walk-Tree($element, [int] $Depth, [scriptblock] $Visit) {
    if ($script:Visited -ge $script:MaxElements) { return }
    if (Test-BudgetExhausted) { return }
    if ($Depth -gt $script:MaxDepth) { return }

    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $child = $null
    try { $child = $walker.GetFirstChild($element) } catch { return }

    while ($null -ne $child) {
        if ($script:Visited -ge $script:MaxElements) { return }
        if (Test-BudgetExhausted) { return }

        $script:Visited++
        & $Visit $child $Depth

        Walk-Tree $child ($Depth + 1) $Visit

        try { $child = $walker.GetNextSibling($child) } catch { return }
    }
}

function Write-Truncation {
    if ($script:Visited -ge $script:MaxElements) {
        Note ('NOTE stopped at the ' + $script:MaxElements + ' element cap. ' +
              'Re-run with a larger max, or inspect a smaller part of the window.')
    }
    elseif (Test-BudgetExhausted) {
        Note ('NOTE stopped after ' + $script:TimeoutSeconds + 's. The window is very large; try a smaller depth.')
    }
}

# Collect every control in a window whose name or automation id contains $Needle.
function Find-Elements($window, [string] $Needle, [bool] $RequireAction) {
    if ([string]::IsNullOrWhiteSpace($Needle)) { Fail 'no element name given' }
    $script:Needle = $Needle.Trim().ToLowerInvariant()
    $script:RequireAction = $RequireAction
    $script:Hits = @()
    $script:Visited = 0

    Walk-Tree $window 0 {
        param($element, $depth)
        $name = (Get-ElName $element).ToLowerInvariant()
        $id = (Get-ElId $element).ToLowerInvariant()
        $matched = $false
        if ($name -ne '' -and $name.Contains($script:Needle)) { $matched = $true }
        if (-not $matched -and $id -ne '' -and $id.Contains($script:Needle)) { $matched = $true }
        if (-not $matched) { return }
        if ($script:RequireAction -and (Get-ElActions $element) -eq '-') { return }
        $script:Hits += $element
    }

    return $script:Hits
}

# ---------------------------------------------------------------------- commands

function Invoke-Apps([string] $Filter) {
    # Get-StartApps is the reliable way to see Store apps as well as desktop ones,
    # and it hands back the AppID needed to launch them.
    $apps = $null
    try { $apps = Get-StartApps -ErrorAction Stop } catch { }
    if ($null -eq $apps) {
        Fail 'Get-StartApps is unavailable on this Windows build; use "open <exe name>" instead.'
    }
    if (-not [string]::IsNullOrWhiteSpace($Filter)) {
        $apps = $apps | Where-Object { $_.Name -like ('*' + $Filter.Trim() + '*') }
    }
    $count = 0
    foreach ($app in $apps) {
        Note ('APP ' + $app.Name + ' | ' + $app.AppID)
        $count++
    }
    Note ('OK count=' + $count)
}

function Invoke-Open([string] $Name) {
    if ([string]::IsNullOrWhiteSpace($Name)) { Fail 'usage: open <app name>' }
    $needle = $Name.Trim()

    # Prefer the Start menu entry, because that is the only thing that launches a
    # Store app such as WhatsApp. Exact name first, then a prefix, then anywhere -
    # otherwise "mail" opens whatever happens to sort first.
    $apps = $null
    try { $apps = Get-StartApps -ErrorAction Stop } catch { }
    $match = $null
    if ($null -ne $apps) {
        $match = $apps | Where-Object { $_.Name -ieq $needle } | Select-Object -First 1
        if ($null -eq $match) {
            $match = $apps | Where-Object { $_.Name -like ($needle + '*') } | Select-Object -First 1
        }
        if ($null -eq $match) {
            $match = $apps | Where-Object { $_.Name -like ('*' + $needle + '*') } | Select-Object -First 1
        }
    }

    if ($null -ne $match) {
        try {
            Start-Process ('shell:AppsFolder\' + $match.AppID) -ErrorAction Stop
            Note ('OK opened ' + $match.Name)
            return
        }
        catch { }
    }

    # Not on the Start menu: treat it as an executable or a document.
    try {
        Start-Process $needle -ErrorAction Stop
        Note ('OK opened ' + $needle)
    }
    catch {
        Fail ("cannot open '" + $needle + "': " + $_.Exception.Message +
              ". Run 'apps " + $needle + "' to see what is actually installed.")
    }
}

function Invoke-Windows {
    $count = 0
    foreach ($window in Get-TopLevelWindows) {
        $name = Get-ElName $window
        if ([string]::IsNullOrWhiteSpace($name)) { continue }
        $processName = '?'
        try {
            $process = Get-Process -Id $window.Current.ProcessId -ErrorAction SilentlyContinue
            if ($null -ne $process) { $processName = $process.ProcessName }
        }
        catch { }
        Note ('WINDOW ' + $name + ' | ' + $processName)
        $count++
    }
    Note ('OK count=' + $count)
}

function Invoke-Focus([string] $Title) {
    $window = Find-Window $Title
    Set-WindowFocus $window
    Note ('OK focused ' + (Get-ElName $window))
}

function Invoke-Inspect([string] $Title, [string] $Depth, [string] $Max) {
    if (-not [string]::IsNullOrWhiteSpace($Depth)) {
        $parsed = 0
        if ([int]::TryParse($Depth, [ref]$parsed) -and $parsed -gt 0) { $script:MaxDepth = $parsed }
    }
    if (-not [string]::IsNullOrWhiteSpace($Max)) {
        $parsed = 0
        if ([int]::TryParse($Max, [ref]$parsed) -and $parsed -gt 0) { $script:MaxElements = $parsed }
    }

    $window = Find-Window $Title
    Note ('WINDOW ' + (Get-ElName $window))
    Note 'COLUMNS depth | type | name | id | actions'

    $script:Visited = 0
    Walk-Tree $window 0 {
        param($element, $depth)
        if (Get-ElOffscreen $element) { return }
        $name = Get-ElName $element
        $id = Get-ElId $element
        # A nameless, idless container tells her nothing and crowds out the rows
        # that matter.
        if ([string]::IsNullOrWhiteSpace($name) -and [string]::IsNullOrWhiteSpace($id)) { return }
        if ($name.Length -gt 120) { $name = $name.Substring(0, 117) + '...' }
        $indent = '  ' * $depth
        Note ($indent + [string]$depth + ' | ' + (Get-ElType $element) + ' | ' + $name + ' | ' + $id + ' | ' + (Get-ElActions $element))
    }

    Write-Truncation
    Note ('OK elements=' + $script:Visited)
}

function Invoke-Read([string] $Title) {
    $window = Find-Window $Title
    Note ('WINDOW ' + (Get-ElName $window))

    $script:Visited = 0
    $script:Seen = New-Object 'System.Collections.Generic.HashSet[string]'

    Walk-Tree $window 0 {
        param($element, $depth)
        if (Get-ElOffscreen $element) { return }
        $type = Get-ElType $element
        if ($type -ne 'Text' -and $type -ne 'Edit' -and $type -ne 'Document' -and $type -ne 'ListItem') { return }
        $text = Get-ElValue $element
        if ([string]::IsNullOrWhiteSpace($text)) { $text = Get-ElName $element }
        if ([string]::IsNullOrWhiteSpace($text)) { return }
        $text = $text.Trim()
        # The same string usually appears on a container and again on its label.
        if (-not $script:Seen.Add($text)) { return }
        Note ('TEXT ' + $text)
    }

    Write-Truncation
    Note ('OK lines=' + $script:Seen.Count)
}

function Invoke-Click([string] $Title, [string] $Target) {
    $window = Find-Window $Title
    Set-WindowFocus $window

    $candidates = @(Find-Elements $window $Target $true)
    if ($candidates.Count -eq 0) {
        # Try again without insisting on a pattern: plenty of real controls in
        # custom-drawn apps expose nothing but a clickable point.
        $candidates = @(Find-Elements $window $Target $false)
    }
    if ($candidates.Count -eq 0) {
        Fail ("no control matching '" + $Target + "' in '" + (Get-ElName $window) +
              "'. Run 'inspect " + $Title + "' to see the real control names.")
    }

    $element = $candidates[0]
    $label = Get-ElName $element
    if ([string]::IsNullOrWhiteSpace($label)) { $label = Get-ElId $element }

    # Invoke first: it is the app's own idea of "this was activated", so it works
    # regardless of where the control sits or whether something covers it.
    $pattern = $null
    try {
        if ($element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
            $pattern.Invoke()
            Note ('OK clicked ' + $label)
            return
        }
    }
    catch { }

    try {
        if ($element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) {
            $pattern.Select()
            Note ('OK selected ' + $label)
            return
        }
    }
    catch { }

    try {
        if ($element.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pattern)) {
            $pattern.Toggle()
            Note ('OK toggled ' + $label)
            return
        }
    }
    catch { }

    # Last resort: a real mouse click at the control's own clickable point.
    try {
        $point = $element.GetClickablePoint()
        if ('SophiaWin' -as [type]) {
            [SophiaWin]::Click([int]$point.X, [int]$point.Y)
            Note ('OK clicked ' + $label + ' (by position)')
            return
        }
    }
    catch { }

    Fail ("found '" + $label + "' but it exposes no way to be clicked. " +
          "Run 'inspect " + $Title + "' and look at the actions column.")
}

function Invoke-SetText([string] $Title, [string] $Target, [string] $Text) {
    if ($null -eq $Text) { $Text = '' }
    $window = Find-Window $Title
    Set-WindowFocus $window

    $candidates = @(Find-Elements $window $Target $false)
    if ($candidates.Count -eq 0) {
        Fail ("no text box matching '" + $Target + "' in '" + (Get-ElName $window) +
              "'. Run 'inspect " + $Title + "' and look for a row with settext in the actions column.")
    }

    $element = $candidates[0]
    $label = Get-ElName $element
    if ([string]::IsNullOrWhiteSpace($label)) { $label = Get-ElId $element }

    $pattern = $null
    try {
        if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
            if (-not $pattern.Current.IsReadOnly) {
                $pattern.SetValue($Text)
                Note ('OK set ' + $label)
                return
            }
        }
    }
    catch { }

    # Many chat and editor inputs are rich-text and refuse SetValue. Focus the box
    # and type into it instead, which is what a person would do.
    try {
        $element.SetFocus()
        Start-Sleep -Milliseconds 250
        [System.Windows.Forms.SendKeys]::SendWait((ConvertTo-SendKeys $Text))
        Note ('OK typed into ' + $label)
    }
    catch {
        Fail ("cannot put text into '" + $label + "': " + $_.Exception.Message)
    }
}

# SendKeys treats these as control characters, so anything meant literally has to
# be wrapped in braces first. Without this, typing an email address or "100%"
# silently turns into modifier keys.
function ConvertTo-SendKeys([string] $Text) {
    if ([string]::IsNullOrEmpty($Text)) { return '' }
    $builder = New-Object System.Text.StringBuilder
    foreach ($char in $Text.ToCharArray()) {
        if ('+^%~(){}[]'.IndexOf($char) -ge 0) {
            [void]$builder.Append('{').Append($char).Append('}')
        }
        else {
            [void]$builder.Append($char)
        }
    }
    return $builder.ToString()
}

function Invoke-Type([string] $Text) {
    if ([string]::IsNullOrEmpty($Text)) { Fail 'usage: type <text>' }
    try {
        [System.Windows.Forms.SendKeys]::SendWait((ConvertTo-SendKeys $Text))
        Note ('OK typed ' + $Text.Length + ' characters')
    }
    catch {
        Fail ('cannot type: ' + $_.Exception.Message)
    }
}

function Invoke-Keys([string] $Combo) {
    if ([string]::IsNullOrWhiteSpace($Combo)) {
        Fail 'usage: keys <combo>   for example: keys {ENTER}   keys ^s   keys %{F4}'
    }
    try {
        [System.Windows.Forms.SendKeys]::SendWait($Combo)
        Note ('OK sent ' + $Combo)
    }
    catch {
        Fail ('cannot send keys: ' + $_.Exception.Message)
    }
}

function Invoke-Close([string] $Title) {
    $window = Find-Window $Title
    $name = Get-ElName $window
    $pattern = $null
    try {
        if ($window.TryGetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern, [ref]$pattern)) {
            $pattern.Close()
            Note ('OK closed ' + $name)
            return
        }
    }
    catch { }
    Fail ("'" + $name + "' will not close through automation. Focus it and use keys %{F4}, if that is really what you want.")
}

function Invoke-Help {
    Note 'COMMANDS apps | open | windows | focus | inspect | read | click | settext | type | keys | close'
    Note 'START    windows           - what is open right now'
    Note '         apps whats        - is WhatsApp installed, and what is its launch id'
    Note '         open WhatsApp     - start it'
    Note '         inspect whatsapp  - see the real controls, then click or settext by name'
    Note 'OK'
}

# --------------------------------------------------------------------------- main

Initialize-Automation

$arg0 = ''
$arg1 = ''
$arg2 = ''
if ($Rest.Count -ge 1) { $arg0 = $Rest[0] }
if ($Rest.Count -ge 2) { $arg1 = $Rest[1] }
if ($Rest.Count -ge 3) { $arg2 = $Rest[2] }

# Free text - a message, a sentence, a window title with spaces - is joined back
# together so the caller does not have to quote it perfectly for it to survive two
# layers of shell.
$all = ''
$from1 = ''
$from2 = ''
if ($Rest.Count -ge 1) { $all = ($Rest -join ' ') }
if ($Rest.Count -ge 2) { $from1 = ($Rest[1..($Rest.Count - 1)] -join ' ') }
if ($Rest.Count -ge 3) { $from2 = ($Rest[2..($Rest.Count - 1)] -join ' ') }

switch ($Command.ToLowerInvariant()) {
    'apps'    { Invoke-Apps    $all }
    'open'    { Invoke-Open    $all }
    'windows' { Invoke-Windows }
    'focus'   { Invoke-Focus   $all }
    'inspect' { Invoke-Inspect $arg0 $arg1 $arg2 }
    'read'    { Invoke-Read    $all }
    'click'   { Invoke-Click   $arg0 $from1 }
    'settext' { Invoke-SetText $arg0 $arg1 $from2 }
    'type'    { Invoke-Type    $all }
    'keys'    { Invoke-Keys    $all }
    'close'   { Invoke-Close   $all }
    'help'    { Invoke-Help }
    default   { Fail ("unknown command '" + $Command + "'. Run with no arguments for the list.") }
}
