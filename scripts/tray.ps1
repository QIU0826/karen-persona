# Karen — 系统托盘图标
# 功能: 显示她在线状态，右键退出
# 启动: powershell -WindowStyle Hidden -File scripts/tray.ps1

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$icon = [System.Drawing.SystemIcons]::Application
$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = $icon
$tray.Visible = $true
$tray.Text = "Karen — 在线中"

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$menu.Items.Add("Karen 在线中") | Out-Null
$menu.Items[0].Enabled = $false
$menu.Items.Add("-") | Out-Null
$menu.Items.Add("打开终端") | Out-Null
$menu.Items[2].Add_Click({
    Start-Process "wt" -ArgumentList "-d `"$PSScriptRoot\..`"" -WindowStyle Normal
})
$menu.Items.Add("PM2 状态") | Out-Null
$menu.Items[3].Add_Click({
    Start-Process "wt" -ArgumentList "npx pm2 status" -WindowStyle Normal
})
$menu.Items.Add("重启 Karen") | Out-Null
$menu.Items[4].Add_Click({
    Set-Location "$PSScriptRoot\.."
    npx pm2 restart karen-qq
    [System.Windows.Forms.MessageBox]::Show("Karen 已重启", "Karen")
})
$menu.Items.Add("-") | Out-Null
$menu.Items.Add("退出 Karen") | Out-Null
$menu.Items[6].Add_Click({
    Set-Location "$PSScriptRoot\.."
    npx pm2 stop karen-qq
    $tray.Visible = $false
    [System.Windows.Forms.Application]::Exit()
})

$tray.ContextMenuStrip = $menu

# 双击打开终端
$tray.Add_DoubleClick({
    Start-Process "wt" -ArgumentList "-d `"$PSScriptRoot\..`"" -WindowStyle Normal
})

# 启动提示
$tray.ShowBalloonTip(3000, "Karen", "她已上线。右键查看选项。", [System.Windows.Forms.ToolTipIcon]::Info)

[System.Windows.Forms.Application]::Run()
