package com.genmnz.holdfast;

interface IShell {
    void destroy() = 16777114;
    // Runs `sh -c cmd` as the shell user. Returns "exit=<n>\n<stdout+stderr>".
    String run(String cmd) = 1;
}
