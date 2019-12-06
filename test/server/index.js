let SuperTokens = require("supertokens-node");
let express = require("express");
let cookieParser = require("cookie-parser");
let bodyParser = require("body-parser");
let http = require("http");

let noOfTimesRefreshCalledDuringTest = 0;

let urlencodedParser = bodyParser.urlencoded({ limit: "20mb", extended: true, parameterLimit: 20000 });
let jsonParser = bodyParser.json({ limit: "20mb" });

let app = express();
app.use(urlencodedParser);
app.use(jsonParser);
app.use(cookieParser());

SuperTokens.init([
    {
        hostname: "localhost",
        port: 8081
    }
]);

app.post("/login", async (req, res) => {
    let userId = req.body.userId;
    await SuperTokens.createNewSession(res, userId);
    res.send(userId);
});

app.get("/", async (req, res) => {
    try {
        await SuperTokens.getSession(req, res, true);
        res.send("success");
    } catch (err) {
        res.status(440).send();
    }
});

app.use("/testing", async (req, res) => {
    let tH = req.headers["testing"];
    if (tH !== undefined) {
        res.header("testing", tH);
    }
    res.send("success");
});

app.post("/logout", async (req, res) => {
    try {
        let sessionInfo = await SuperTokens.getSession(req, res, true);
        await sessionInfo.revokeSession();
        res.send("success");
    } catch (err) {
        res.status(440).send();
    }
});

app.post("/revokeAll", async (req, res) => {
    try {
        let sessionInfo = await SuperTokens.getSession(req, res, true);
        let userId = sessionInfo.userId;
        await SuperTokens.revokeAllSessionsForUser(userId);
        res.send("success");
    } catch (err) {
        res.status(440).send();
    }
});

app.post("/refresh", async (req, res) => {
    try {
        await SuperTokens.refreshSession(req, res);
        refreshCalled = true;
        noOfTimesRefreshCalledDuringTest += 1;
    } catch (err) {
        res.status(440).send();
        return;
    }
    res.send("success");
});

app.get("/refreshCalledTime", async (req, res) => {
    res.send(noOfTimesRefreshCalledDuringTest);
});

app.get("/ping", async (req, res) => {
    res.send("success");
});

app.get("/testHeader", async (req, res) => {
    let testHeader = req.headers["st-custom-header"];
    let success = true;
    if (testHeader === undefined) {
        success = false;
    }
    let data = {
        success
    };
    res.send(JSON.stringify(data));
});

app.use("*", async (req, res, next) => {
    res.status(404).send();
});

app.use("*", async (err, req, res, next) => {
    res.send(500).send(err);
});

let server = http.createServer(app);
server.listen(8080, "localhost");