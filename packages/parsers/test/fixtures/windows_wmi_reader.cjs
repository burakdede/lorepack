// WSH JScript test control, never a production reader or Node module.
// biome-ignore-all lint/style/useConst: Windows Script Host JScript requires ES3 var declarations.
(function () {
  var WScript = this.WScript;
  var ActiveXObject = this.ActiveXObject;
  var stage = 'arguments';
  var pidText,
    birth,
    locator,
    service,
    path,
    date,
    process,
    expectedBirth,
    actualBirth,
    raw,
    rss,
    code;
  try {
    if (WScript.Arguments.length !== 2) throw new Error('Invalid arguments');
    pidText = String(WScript.Arguments.Item(0));
    birth = String(WScript.Arguments.Item(1));
    if (!/^[1-9][0-9]{0,9}$/.test(pidText) || Number(pidText) > 2147483647)
      throw new Error('Invalid PID');
    if (!/^[0-9]{1,20}$/.test(birth)) throw new Error('Invalid creation identity');
    stage = 'connect';
    locator = new ActiveXObject('WbemScripting.SWbemLocator');
    service = locator.ConnectServer('.', 'root\\cimv2');
    service.Security_.ImpersonationLevel = 3;
    path = "Win32_Process.Handle='".concat(pidText, "'");
    date = new ActiveXObject('WbemScripting.SWbemDateTime');
    while (true) {
      stage = 'get';
      process = service.Get(path, 0);
      stage = 'identity';
      date.Value = String(process.CreationDate);
      actualBirth = String(date.GetFileTime(false));
      date.SetFileTime(birth, false);
      expectedBirth = String(date.GetFileTime(false));
      // WMI CreationDate has microsecond precision, so ignore FILETIME's 100 ns digit.
      if (
        String(process.Handle) !== pidText ||
        actualBirth.slice(0, -1) !== expectedBirth.slice(0, -1)
      )
        throw new Error('Process identity changed');
      stage = 'rss';
      raw = String(process.WorkingSetSize);
      if (!/^[0-9]{1,16}$/.test(raw)) throw new Error('Invalid RSS');
      rss = Number(raw);
      if (Math.floor(rss) !== rss || rss <= 0 || rss > 9007199254740991)
        throw new Error('Invalid RSS');
      stage = 'write';
      WScript.StdOut.WriteLine(rss.toString());
      stage = 'sleep';
      WScript.Sleep(100);
    }
  } catch (error) {
    if (stage === 'identity')
      code = 'expected='.concat(String(expectedBirth), ',actual=', String(actualBirth));
    else code = typeof error.number === 'number' ? (error.number >>> 0).toString(16) : 'none';
    WScript.StdErr.WriteLine('LPF:'.concat(stage, ':', code));
    WScript.Quit(1);
  }
}).call(this);
