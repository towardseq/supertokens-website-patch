/* Copyright (c) 2020, VRAI Labs and/or its affiliates. All rights reserved.
 *
 * This software is licensed under the Apache License, Version 2.0 (the
 * "License") as published by the Apache Software Foundation.
 *
 * You may not use this file except in compliance with the License. You may
 * obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
 * WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
 * License for the specific language governing permissions and limitations
 * under the License.
 */
let axios = require("axios");
let puppeteer = require("puppeteer");
let decodeJWT = require("jsonwebtoken").decode;
let verifyJWT = require("jsonwebtoken").verify;
let jwksClient = require("jwks-rsa");
let assert = require("assert");
let {
    delay,
    getNumberOfTimesRefreshCalled,
    startST,
    startSTWithJWTEnabled,
    getNumberOfTimesGetSessionCalled,
    BASE_URL,
    BASE_URL_FOR_ST,
    coreTagEqualToOrAfter,
    checkIfJWTIsEnabled,
    checkIfV3AccessTokenIsSupported
} = require("./utils");
const { spawn } = require("child_process");
const { addGenericTestCases: addTestCases } = require("./interception.testgen");

/* TODO: 
    - User passed config should be sent as well
    - session should not exist when user's session fully expires - use doesSessionExist & check localstorage is empty
    - while logged in, test that APIs that there is proper change in id refresh cookie
    - tests APIs that don't require authentication work after logout - with-credentials don't get sent.
    - if not logged in, test that API that requires auth throws session expired
    - Test everything without and without interception
    - If user provides withCredentials as false or whatever, then app should not add it
    - Cross origin API requests to API that requires Auth
    - Cross origin API request to APi that doesn't require auth
    - Proper change in anti-csrf token once access token resets
    - Refresh API custom headers are working
    - allow-credentials should not be sent by our SDK by default.
    - User passed config should be sent as well
*/

/* setupFunc is called through page.evaluate at the start of each test
    It should set window.toTest to a function that receives a config object with:
        url
        method
        headers (as object)
        body
    and should return a response object with:
        url
        statusCode
        headers (as Headers)
        responseText (text)
*/

addTestCases((name, transferMethod, setupFunc, setupArgs = []) => {
    describe(`${name}: interception basic tests 1`, function () {
        let browser;
        let page;
        let v3AccessTokenSupported;

        function setup(config = {}) {
            // page.on("console", c => console.log(c.text()));
            return page.evaluate(
                setupFunc,
                {
                    // enableDebugLogs: true,
                    ...config
                },
                ...setupArgs
            );
        }

        before(async function () {
            spawn(
                "./test/startServer",
                [process.env.INSTALL_PATH, process.env.NODE_PORT === undefined ? 8080 : process.env.NODE_PORT],
                {
                    // stdio: "inherit",
                    // env: {
                    //     ...process.env,
                    //     DEBUG: "com.supertokens",
                    // }
                }
            );
            await new Promise(r => setTimeout(r, 1000));
            v3AccessTokenSupported = await checkIfV3AccessTokenIsSupported();
        });

        after(async function () {
            let instance = axios.create();
            await instance.post(BASE_URL_FOR_ST + "/after");
            try {
                await instance.get(BASE_URL_FOR_ST + "/stop");
            } catch (err) {}
        });

        beforeEach(async function () {
            let instance = axios.create();
            await instance.post(BASE_URL_FOR_ST + "/beforeeach");
            await instance.post("http://localhost.org:8082/beforeeach"); // for cross domain
            await instance.post(BASE_URL + "/beforeeach");

            let launchRetries = 0;
            while (browser === undefined && launchRetries++ < 3) {
                try {
                    browser = await puppeteer.launch({
                        args: ["--no-sandbox", "--disable-setuid-sandbox"],
                        headless: true
                    });
                } catch {}
            }
            page = await browser.newPage();

            await page.goto(BASE_URL + "/index.html", { waitUntil: "load" });
            await page.addScriptTag({ path: `./bundle/bundle.js`, type: "text/javascript" });
            page.evaluate(BASE_URL => (window.BASE_URL = BASE_URL), BASE_URL);
        });

        afterEach(async function () {
            if (browser) {
                await browser.close();
                browser = undefined;
            }
        });

        it("testing api methods without config", async function () {
            await setup();

            await page.evaluate(async () => {
                for (const method of ["GET", "POST", "DELETE", "PUT"]) {
                    const response = await toTest({ url: `${BASE_URL}/testing`, method });
                    assert.strictEqual(response.statusCode, 200);
                    assert.strictEqual(response.responseText, "success");
                }
            });
        });

        it("testing api methods with config", async function () {
            await setup();
            await page.evaluate(async () => {
                const testing = "testing";
                for (const method of ["GET", "POST", "DELETE", "PUT"]) {
                    const response = await toTest({ url: `${BASE_URL}/testing`, method, headers: { testing } });
                    assert.strictEqual(response.statusCode, 200);
                    assert.strictEqual(response.responseText, "success");
                    assert.strictEqual(response.headers.get("testing"), testing);
                }
            });
        });

        it("testing api methods that doesn't exists", async function () {
            await setup();
            await page.evaluate(async () => {
                const testing = "testing";
                for (const method of ["GET", "POST", "DELETE", "PUT"]) {
                    const response = await toTest({ url: `${BASE_URL}/fail`, method, headers: { testing } });
                    assert.strictEqual(response.statusCode, 404);
                }
            });
        });

        it("test refresh session", async function () {
            await startST(3);
            await setup();
            await page.evaluate(async () => {
                const userId = "testing-supertokens-website";
                const loginResponse = await toTest({
                    url: `${BASE_URL}/login`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ userId })
                });

                assert.strictEqual(loginResponse.statusCode, 200);
                assert.strictEqual(loginResponse.responseText, userId);
                //delay for 5 seconds for access token validity expiry
                await delay(5);

                //check that the number of times the refreshAPI was called is 0
                assert.strictEqual(await getNumberOfTimesRefreshCalled(), 0);

                let getResponse = await toTest({ url: `${BASE_URL}/` });
                //check that the response to getSession was success
                assert.strictEqual(getResponse.statusCode, 200);
                assert.strictEqual(getResponse.responseText, userId);

                //check that the number of time the refreshAPI was called is 1
                assert.strictEqual(await getNumberOfTimesRefreshCalled(), 1);
            });
        });

        it("test refresh session with multiple 401s", async function () {
            await startST(3);
            await setup();
            await page.setRequestInterception(true);
            let getCount = 0;
            page.on("request", req => {
                const url = req.url();
                if (url === BASE_URL + "/") {
                    if (getCount++ < 3) {
                        req.respond({
                            status: 401,
                            body: JSON.stringify({
                                message: "try refresh token"
                            })
                        });
                    } else {
                        req.respond({
                            status: 200,
                            body: JSON.stringify({
                                success: true
                            })
                        });
                    }
                } else {
                    req.continue();
                }
            });
            await page.evaluate(async () => {
                const userId = "testing-supertokens-website";
                const loginResponse = await toTest({
                    url: `${BASE_URL}/login`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ userId })
                });

                assert.strictEqual(loginResponse.statusCode, 200);
                assert.strictEqual(loginResponse.responseText, userId);
                //delay for 5 seconds for access token validity expiry
                await delay(5);

                //check that the number of times the refreshAPI was called is 0
                assert.strictEqual(await getNumberOfTimesRefreshCalled(), 0);

                let getResponse = await toTest({ url: `${BASE_URL}/` });
                //check that the response to getSession was success
                assert.strictEqual(getResponse.statusCode, 200);
                assert.deepStrictEqual(JSON.parse(getResponse.responseText), { success: true });

                assert.strictEqual(await getNumberOfTimesRefreshCalled(), 3);
            });
            await page.setRequestInterception(false);
        });

        it("test session after signing key change", async function () {
            // We can have access tokens valid for longer than the signing key update interval
            await startST(100, true, "0.002");
            await setup();

            await page.evaluate(async coreSupportsMultipleSignigKeys => {
                let userId = "testing-supertokens-website";

                let loginResponse = await toTest({
                    url: `${BASE_URL}/login`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ userId })
                });

                assert.strictEqual(await loginResponse.responseText, userId);

                //delay for 11 seconds for access token signing key to change
                assert.strictEqual(await getNumberOfTimesRefreshCalled(), 0);
                await delay(11);

                //check that the number of times the refreshAPI was called is 0
                assert.strictEqual(await getNumberOfTimesRefreshCalled(), 0);

                const promises = [];
                for (let i = 0; i < 250; i++) {
                    promises.push(await toTest({ url: `${BASE_URL}/` }).catch(() => {}));
                }
                await Promise.all(promises);

                assert.strictEqual(await getNumberOfTimesRefreshCalled(), coreSupportsMultipleSignigKeys ? 0 : 1);
            }, coreTagEqualToOrAfter("3.6.0"));
        });

        it("test sameSite is none if using iframe", async function () {
            await startST(3);
            await setup({
                isInIframe: true
            });
            await page.evaluate(async () => {
                const userId = "testing-supertokens-website";

                await toTest({
                    url: `${BASE_URL}/login`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ userId })
                });
            });

            const cookies = await page.cookies();
            assert.strictEqual(cookies.length, 0);
        });

        it("test rid is there", async function () {
            await startST(3);
            await setup();

            await page.evaluate(async () => {
                let userId = "testing-supertokens-website";

                let loginResponse = await toTest({
                    url: `${BASE_URL}/login`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ userId })
                });
                assert.strictEqual(loginResponse.responseText, userId);

                let getResponse = await toTest({ url: `${BASE_URL}/check-rid` });
                assert.strictEqual(getResponse.responseText, "success");
            });
        });

        it("signout with expired access token", async function () {
            await startST();
            await setup();

            await page.evaluate(async () => {
                let userId = "testing-supertokens-website";

                let loginResponse = await toTest({
                    url: `${BASE_URL}/login`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ userId })
                });

                assert.strictEqual(loginResponse.responseText, userId);
                await delay(5);
                assert.strictEqual(await getNumberOfTimesRefreshCalled(), 0);
                await supertokens.signOut();
                assert.strictEqual(await getNumberOfTimesRefreshCalled(), 1);
                assert.strictEqual(await supertokens.doesSessionExist(), false);
            });
        });

        it("signout with not expired access token", async function () {
            await startST();
            await setup();

            await page.evaluate(async () => {
                let userId = "testing-supertokens-website";

                let loginResponse = await toTest({
                    url: `${BASE_URL}/login`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ userId })
                });

                assert.strictEqual(loginResponse.responseText, userId);
                assert.strictEqual(await getNumberOfTimesRefreshCalled(), 0);
                await supertokens.signOut();
                assert.strictEqual(await getNumberOfTimesRefreshCalled(), 0);
                assert.strictEqual(await supertokens.doesSessionExist(), false);

                const getSessionResponse = await toTest({ url: `${BASE_URL}/` });

                //check that the response to getSession after signout is 401
                assert.strictEqual(getSessionResponse.statusCode, 401);
                assert.strictEqual(getSessionResponse.url, `${BASE_URL}/`);
                assert.strictEqual(await getNumberOfTimesRefreshAttempted(), 1);
            });
        });

        it("signout without empty headers in response", async function () {
            if (transferMethod !== "header") {
                return;
            }

            await startST();
            await setup();

            await page.setRequestInterception(true);

            page.on("request", async req => {
                const url = req.url();
                if (url.endsWith("signout")) {
                    req.respond({
                        status: 200,
                        headers: {
                            "front-token": "remove"
                        },
                        body: "{}"
                    });
                } else {
                    req.continue();
                }
            });

            await page.evaluate(async () => {
                let userId = "testing-supertokens-website";

                let loginResponse = await toTest({
                    url: `${BASE_URL}/login`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ userId })
                });

                assert.strictEqual(loginResponse.responseText, userId);
                assert.strictEqual(await getNumberOfTimesRefreshCalled(), 0);
                await supertokens.signOut();
                assert.strictEqual(await getNumberOfTimesRefreshCalled(), 0);

                assert.strictEqual(await supertokens.getAccessToken(), undefined);
                assert.strictEqual(await supertokens.doesSessionExist(), false);

                const getSessionResponse = await toTest({ url: `${BASE_URL}/` });

                //check that the response to getSession after signout is 401
                assert.strictEqual(getSessionResponse.statusCode, 401);
                assert.strictEqual(getSessionResponse.url, `${BASE_URL}/`);
                assert.strictEqual(await getNumberOfTimesRefreshAttempted(), 1);
            });
        });

        it("test update jwt data ", async function () {
            await startST(3);
            await setup();

            await page.evaluate(async v3AccessTokenSupported => {
                let userId = "testing-supertokens-website";

                // send api request to login
                let loginResponse = await toTest({
                    url: `${BASE_URL}/login`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ userId })
                });

                assert.strictEqual(loginResponse.responseText, userId);
                let data = await supertokens.getAccessTokenPayloadSecurely();

                assert.strictEqual(Object.keys(data).length, v3AccessTokenSupported ? 8 : 0);

                // update jwt data
                let testResponse1 = await toTest({
                    url: `${BASE_URL}/update-jwt`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ key: "łukasz 馬 / 马" })
                });
                let data1 = JSON.parse(testResponse1.responseText);
                assert.strictEqual(data1.key, "łukasz 馬 / 马");

                data = await supertokens.getAccessTokenPayloadSecurely();
                assert.strictEqual(data.key, "łukasz 馬 / 马");

                //delay for 5 seconds for access token validity expiry
                await delay(5);

                //check that the number of times the refreshAPI was called is 0
                assert.strictEqual(await getNumberOfTimesRefreshCalled(), 0);

                // get jwt data
                let testResponse2 = await toTest({ url: `${BASE_URL}/update-jwt`, method: "get" });
                let data2 = JSON.parse(testResponse2.responseText);
                assert.strictEqual(data2.key, "łukasz 馬 / 马");
                assert.strictEqual(await getNumberOfTimesRefreshCalled(), 1);

                // update jwt data
                let testResponse3 = await toTest({
                    url: `${BASE_URL}/update-jwt`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ key1: " łukasz data1" })
                });
                let data3 = JSON.parse(testResponse3.responseText);
                assert.strictEqual(data3.key1, " łukasz data1");
                assert.strictEqual(data3.key, undefined);

                data = await supertokens.getAccessTokenPayloadSecurely();
                assert.strictEqual(data.key1, " łukasz data1");
                assert.strictEqual(data.key, undefined);

                // get jwt data
                let testResponse4 = await toTest({ url: `${BASE_URL}/update-jwt`, method: "get" });
                let data4 = JSON.parse(testResponse4.responseText);
                assert.strictEqual(data4.key1, " łukasz data1");
                assert.strictEqual(data4.key, undefined);
            }, v3AccessTokenSupported);
        });

        //test custom headers are being sent when logged in and when not*****
        it("test that custom headers are being sent", async function () {
            await startST();
            await setup();

            await page.evaluate(async () => {
                let userId = "testing-supertokens-website";

                //send loing request
                let loginResponse = await toTest({
                    url: `${BASE_URL}/login`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ userId })
                });
                assert.strictEqual(loginResponse.responseText, userId);

                //send api request with custom headers and check that they are set
                let testResponse = await toTest({
                    url: `${BASE_URL}/testing`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json",
                        testing: "testValue"
                    }
                });

                // check that output is success
                assert.strictEqual(testResponse.responseText, "success");
                //check that the custom headers are present
                assert.strictEqual(await testResponse.headers.get("testing"), "testValue");

                //send logout request
                let logoutResponse = await toTest({
                    url: `${BASE_URL}/logout`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ userId })
                });

                assert.strictEqual(logoutResponse.responseText, "success");

                let testResponse2 = await toTest({
                    url: `${BASE_URL}/testing`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json",
                        testing: "testValue"
                    }
                });

                // check that output is success
                assert.strictEqual(testResponse2.responseText, "success");
                //check that the custom headers are present
                assert.strictEqual(await testResponse2.headers.get("testing"), "testValue");
            });
        });

        //testing doesSessionExist works fine when user is logged in******
        it("test that doesSessionExist works fine when the user is logged in", async function () {
            await startST();
            await setup();

            await page.evaluate(async () => {
                let userId = "testing-supertokens-website";

                //send loing request
                let loginResponse = await toTest({
                    url: `${BASE_URL}/login`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ userId })
                });
                assert.strictEqual(loginResponse.responseText, userId);

                assert.strictEqual(await supertokens.doesSessionExist(), true);
            });
        });

        //session should not exist when user calls log out - use doesSessionExist & check localstorage is empty
        it("test session should not exist when user calls log out", async function () {
            await startST();
            await setup();
            await page.evaluate(async () => {
                function getAntiCSRFromCookie() {
                    let value = "; " + document.cookie;
                    let parts = value.split("; sAntiCsrf=");
                    if (parts.length >= 2) {
                        let last = parts.pop();
                        if (last !== undefined) {
                            return last;
                        }
                    }
                    return null;
                }
                let BASE_URL = "http://localhost.org:8080";
                supertokens.init({
                    apiDomain: BASE_URL
                });
                let userId = "testing-supertokens-website";

                // send api request to login
                let loginResponse = await toTest({
                    url: `${BASE_URL}/login`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ userId })
                });
                assert.strictEqual(loginResponse.responseText, userId);

                assert.strictEqual(await supertokens.doesSessionExist(), true);
                assert.notEqual(getAntiCSRFromCookie(), null);

                let userIdFromToken = await supertokens.getUserId();
                assert.strictEqual(userIdFromToken, userId);

                // send api request to logout
                let logoutResponse = await toTest({
                    url: `${BASE_URL}/logout`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ userId })
                });

                assert.strictEqual(logoutResponse.responseText, "success");
                assert.strictEqual(await supertokens.doesSessionExist(), false);
                assert.strictEqual(getAntiCSRFromCookie(), null);

                try {
                    await supertokens.getUserId();
                    throw new Error("test failed");
                } catch (err) {
                    assert.strictEqual(err.message, "No session exists");
                }

                try {
                    await supertokens.getAccessTokenPayloadSecurely();
                    throw new Error("test failed");
                } catch (err) {
                    assert.strictEqual(err.message, "No session exists");
                }
            });
        });

        // testing attemptRefreshingSession works fine******
        it("test that attemptRefreshingSession is working correctly", async function () {
            await startST(5);
            await setup();

            await page.evaluate(async () => {
                let userId = "testing-supertokens-website";

                // send api request to login
                let loginResponse = await toTest({
                    url: `${BASE_URL}/login`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ userId })
                });
                assert.strictEqual(loginResponse.responseText, userId);

                await delay(5);
                let attemptRefresh = await supertokens.attemptRefreshingSession();
                assert.strictEqual(attemptRefresh, true);

                //check that the number of times the refresh API was called is 1
                assert.strictEqual(await getNumberOfTimesRefreshCalled(), 1);

                let getSessionResponse = await toTest({ url: `${BASE_URL}/` });
                assert.strictEqual(getSessionResponse.responseText, userId);

                //check that the number of times the refresh API was called is still 1
                assert.strictEqual(await getNumberOfTimesRefreshCalled(), 1);
            });
        });

        // multiple API calls in parallel when access token is expired (100 of them) and only 1 refresh should be called*****
        it("test that multiple API calls in parallel when access token is expired, only 1 refresh should be called", async function () {
            await startST(15);
            await setup();
            await page.evaluate(async () => {
                let userId = "testing-supertokens-website";

                // send api request to login
                let loginResponse = await toTest({
                    url: `${BASE_URL}/login`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ userId })
                });
                assert.strictEqual(loginResponse.responseText, userId);
                assert.strictEqual(await getNumberOfTimesRefreshCalled(), 0);

                // wait for 7 seconds so that the accesstoken expires
                await delay(17);

                let promises = [];
                let n = 100;

                // create an array of 100 get session promises
                for (let i = 0; i < n; i++) {
                    promises.push(
                        toTest({
                            url: `${BASE_URL}/`,
                            method: "GET",
                            headers: { "Cache-Control": "no-cache, private" }
                        })
                    );
                }

                // send 100 get session requests
                let multipleGetSessionResponse = await Promise.all(promises);

                //check that reponse of all requests are success
                let noOfResponeSuccesses = 0;
                for (let i = 0; i < multipleGetSessionResponse.length; i++) {
                    assert.strictEqual(await multipleGetSessionResponse[i].responseText, userId);
                    noOfResponeSuccesses += 1;
                }

                //check that the number of times refresh is called is 1

                assert.strictEqual(await getNumberOfTimesRefreshCalled(), 1);
                assert.strictEqual(noOfResponeSuccesses, n);
            });
        });

        // multiple API calls in parallel when access token is expired (100 of them) and only 1 refresh should be called*****
        it("test that multiple API calls in parallel when access token is expired, only 1 refresh should be called - with delayed calls", async function () {
            await startST(15);
            await setup();
            await page.evaluate(async () => {
                let userId = "testing-supertokens-website";

                // send api request to login
                let loginResponse = await toTest({
                    url: `${BASE_URL}/login`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ userId })
                });
                assert.strictEqual(loginResponse.responseText, userId);
                assert.strictEqual(await getNumberOfTimesRefreshCalled(), 0);

                // wait for 7 seconds so that the accesstoken expires
                await delay(17);

                let promises = [];
                let n = 100;

                // create an array of 100 get session promises
                for (let i = 0; i < n; i++) {
                    // this will make it so that there are calls to the / API during the refresh call.
                    // these calls should not cause another refresh, cause the tokens would have changed.
                    await new Promise(r => setTimeout(r, 3 * Math.random()));
                    promises.push(
                        toTest({
                            url: `${BASE_URL}/`,
                            method: "GET",
                            headers: { "Cache-Control": "no-cache, private" }
                        })
                    );
                }

                // send 100 get session requests
                let multipleGetSessionResponse = await Promise.all(promises);

                //check that reponse of all requests are success
                let noOfResponeSuccesses = 0;
                for (let i = 0; i < multipleGetSessionResponse.length; i++) {
                    assert.strictEqual(await multipleGetSessionResponse[i].responseText, userId);
                    noOfResponeSuccesses += 1;
                }

                //check that the number of times refresh is called is 1

                try {
                    assert.strictEqual(await getNumberOfTimesRefreshCalled(), 1);
                } catch (err) {
                    // this happens sometimes for python testing where the number of refreshes is
                    // 2.
                    assert.strictEqual(await getNumberOfTimesRefreshCalled(), 2);
                }
                assert.strictEqual(noOfResponeSuccesses, n);
            });
        });

        // - Things should work if anti-csrf is disabled.******
        it("test that things should work correctly if anti-csrf is disabled", async function () {
            await startST(3, false);
            await setup();

            await page.evaluate(async () => {
                let userId = "testing-supertokens-website";

                // send api request to login
                let loginResponse = await toTest({
                    url: `${BASE_URL}/login`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ userId })
                });
                assert.strictEqual(loginResponse.responseText, userId);
                assert.strictEqual(await supertokens.doesSessionExist(), true);
                assert.strictEqual(await getNumberOfTimesRefreshCalled(), 0);

                await delay(5);

                let getSessionResponse = await toTest({ url: `${BASE_URL}/` });

                assert.strictEqual(getSessionResponse.responseText, userId);
                assert.strictEqual(await getNumberOfTimesRefreshCalled(), 1);

                let logoutResponse = await toTest({
                    url: `${BASE_URL}/logout`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ userId })
                });

                assert.strictEqual(await supertokens.doesSessionExist(), false);
                assert.strictEqual(logoutResponse.responseText, "success");
            });
        });

        // if any API throws error, it gets propagated to the user properly (with and without interception)******
        it("test that if an api throws an error it gets propagated to the user with interception", async () => {
            await startST();
            await setup();
            await page.evaluate(async () => {
                let BASE_URL = "http://localhost.org:8080";
                supertokens.init({
                    apiDomain: BASE_URL
                });

                let val = await toTest({ url: `${BASE_URL}/testError` });
                assert.strictEqual(val.responseText, "test error message");
                assert.strictEqual(val.statusCode, 500);
            });
        });

        it("test that if an api throws a 400 error it gets propagated to the user with interception", async () => {
            await startST();
            await setup();
            await page.evaluate(async () => {
                let BASE_URL = "http://localhost.org:8080";
                supertokens.init({
                    apiDomain: BASE_URL
                });

                let val = await toTest({ url: `${BASE_URL}/testError?code=400` });
                assert.strictEqual(val.responseText, "test error message");
                assert.strictEqual(val.statusCode, 400);
            });
        });

        it("test that if an api throws a 405 error it gets propagated to the user with interception", async () => {
            await startST();
            await setup();
            await page.evaluate(async () => {
                let BASE_URL = "http://localhost.org:8080";
                supertokens.init({
                    apiDomain: BASE_URL
                });

                let val = await toTest({ url: `${BASE_URL}/testError?code=405` });
                assert.strictEqual(val.responseText, "test error message");
                assert.strictEqual(val.statusCode, 405);
            });
        });

        it("test that if an api throws an error it gets propagated to the user without interception", async () => {
            await startST();
            await setup();

            await page.evaluate(async () => {
                let BASE_URL = "http://localhost.org:8080";
                supertokens.init({
                    apiDomain: BASE_URL
                });

                let val = await toTest({ url: `${BASE_URL}/testError#superTokensDoNotDoInterception`, method: "get" });

                assert.strictEqual(val.responseText, "test error message");
                assert.strictEqual(val.statusCode, 500);
            });
        });

        it("test that if an api throws a 400 error it gets propagated to the user without interception", async () => {
            await startST();
            await setup();

            await page.evaluate(async () => {
                let BASE_URL = "http://localhost.org:8080";
                supertokens.init({
                    apiDomain: BASE_URL
                });

                let val = await toTest({
                    url: `${BASE_URL}/testError?code=400#superTokensDoNotDoInterception`,
                    method: "get"
                });

                assert.strictEqual(val.responseText, "test error message");
                assert.strictEqual(val.statusCode, 400);
            });
        });

        it("test that if an api throws a 405 error it gets propagated to the user without interception", async () => {
            await startST();
            await setup();

            await page.evaluate(async () => {
                let BASE_URL = "http://localhost.org:8080";
                supertokens.init({
                    apiDomain: BASE_URL
                });

                let val = await toTest({ url: `${BASE_URL}/testError?code=405`, method: "get" });

                assert.strictEqual(val.responseText, "test error message");
                assert.strictEqual(val.statusCode, 405);
            });
        });

        it("test that network errors are propagated to the user with interception", async () => {
            await startST();
            await setup();

            await page.setRequestInterception(true);
            page.on("request", req => {
                const url = req.url();
                if (url === BASE_URL + "/testError") {
                    req.abort();
                } else {
                    req.continue();
                }
            });

            await page.evaluate(async () => {
                let BASE_URL = "http://localhost.org:8080";
                supertokens.init({
                    apiDomain: BASE_URL
                });

                let caught;
                try {
                    await toTest({ url: `${BASE_URL}/testError`, method: "get" });
                } catch (ex) {
                    caught = ex;
                }

                assert.ok(caught);
            });
        });

        it("test that network errors are propagated to the user without interception", async () => {
            await startST();
            await setup();

            await page.setRequestInterception(true);
            page.on("request", req => {
                const url = req.url();
                if (url === BASE_URL + "/testError") {
                    req.abort();
                } else {
                    req.continue();
                }
            });

            await page.evaluate(async () => {
                let BASE_URL = "http://localhost.org:8080";
                supertokens.init({
                    apiDomain: BASE_URL
                });

                let caught;
                try {
                    await toTest({ url: `${BASE_URL}/testError#superTokensDoNotDoInterception`, method: "get" });
                } catch (ex) {
                    caught = ex;
                }

                assert.ok(caught);
            });
        });

        //    - Calling SuperTokens.init more than once works!*******
        it("test that calling SuperTokens.init more than once works", async () => {
            await startST();
            await setup();
            await page.evaluate(async () => {
                supertokens.init({
                    apiDomain: BASE_URL
                });
                let userId = "testing-supertokens-website";

                let loginResponse = await toTest({
                    url: `${BASE_URL}/login`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ userId })
                });

                assert.strictEqual(loginResponse.responseText, userId);
                supertokens.init({
                    apiDomain: BASE_URL
                });

                let logoutResponse = await toTest({
                    url: `${BASE_URL}/logout`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ userId })
                });

                assert.strictEqual(logoutResponse.responseText, "success");

                //check that session does not exist
                assert.strictEqual(await supertokens.doesSessionExist(), false);

                //check that login still works correctly
                loginResponse = await toTest({
                    url: `${BASE_URL}/login`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ userId })
                });

                assert.strictEqual(loginResponse.responseText, userId);
            });
        });

        //If via interception, make sure that initially, just an endpoint is just hit twice in case of access token expiry*****
        it("test that if via interception, initially an endpoint is hit just twice in case of access token expiary", async () => {
            await startST(3);
            await setup();
            await page.evaluate(async () => {
                let BASE_URL = "http://localhost.org:8080";
                supertokens.init({
                    apiDomain: BASE_URL
                });
                let userId = "testing-supertokens-website";

                // send api request to login
                let loginResponse = await toTest({
                    url: `${BASE_URL}/login`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ userId })
                });

                assert.strictEqual(loginResponse.responseText, userId);

                //wait for 3 seconds such that the session expires
                await delay(5);

                let getSessionResponse = await toTest({ url: `${BASE_URL}/` });
                assert.strictEqual(getSessionResponse.responseText, userId);

                //check that the number of times getSession was called is 1
                assert.strictEqual(await getNumberOfTimesGetSessionCalled(), 1);

                //check that the number of times refesh session was called is 1
                assert.strictEqual(await getNumberOfTimesRefreshCalled(), 1);
            });
        });

        //- If you make an api call without cookies(logged out) api throws session expired , then make sure that refresh token api is not getting called , get 401 as the output****
        it("test that an api call without cookies throws session expire, refresh api is not called and 401 is the output", async function () {
            await startST(5);
            await setup();

            await page.evaluate(async () => {
                let BASE_URL = "http://localhost.org:8080";
                supertokens.init({
                    apiDomain: BASE_URL
                });
                let userId = "testing-supertokens-website";

                let loginResponse = await toTest({
                    url: `${BASE_URL}/login`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ userId })
                });

                assert.strictEqual(loginResponse.responseText, userId);

                let logoutResponse = await toTest({
                    url: `${BASE_URL}/logout`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ userId })
                });

                assert.strictEqual(logoutResponse.responseText, "success");

                let getSessionResponse = await toTest({ url: `${BASE_URL}/` });

                //check that the response to getSession without cookies is 401
                assert.strictEqual(getSessionResponse.statusCode, 401);

                assert.strictEqual(getSessionResponse.url, `${BASE_URL}/`);
                assert.strictEqual(await getNumberOfTimesRefreshAttempted(), 1);
            });
        });

        //    - If via interception, make sure that initially, just an endpoint is just hit once in case of access token NOT expiry*****
        it("test that via interception initially an endpoint is just hit once in case of valid access token", async function () {
            await startST(5);
            await setup();

            await page.evaluate(async () => {
                let BASE_URL = "http://localhost.org:8080";
                supertokens.init({
                    apiDomain: BASE_URL
                });
                let userId = "testing-supertokens-website";

                // send api request to login
                let loginResponse = await toTest({
                    url: `${BASE_URL}/login`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ userId })
                });

                assert.strictEqual(loginResponse.responseText, userId);

                let getSessionResponse = await toTest({ url: `${BASE_URL}/` });
                assert.strictEqual(getSessionResponse.responseText, userId);

                //check that the number of times getSession was called is 1
                assert.strictEqual(await getNumberOfTimesGetSessionCalled(), 1);

                //check that the number of times refresh session was called is 0
                assert.strictEqual(await getNumberOfTimesRefreshCalled(), 0);
            });
        });

        it("test interception should happen if api domain and website domain are the same and relative path is used", async function () {
            await startST(5);
            await setup();

            await page.evaluate(async () => {
                let BASE_URL = "http://localhost.org:8080";
                supertokens.init({
                    apiDomain: BASE_URL
                });
                let userId = "testing-supertokens-website";

                // send api request to login
                let loginResponse = await toTest({
                    url: `/login`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ userId })
                });

                assert.strictEqual(loginResponse.responseText, userId);

                assert.strictEqual(await supertokens.doesSessionExist(), true);
            });
        });

        it("test interception should not happen if api domain and website domain are different and relative path is used", async function () {
            await startST(5);
            await setup();

            await page.evaluate(async () => {
                let BASE_URL = "https://google.com";
                supertokens.init({
                    apiDomain: BASE_URL
                });
                let userId = "testing-supertokens-website";

                // send api request to login
                let loginResponse = await toTest({
                    url: `/login`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ userId })
                });

                assert.strictEqual(loginResponse.responseText, userId);

                assert.strictEqual(await supertokens.doesSessionExist(), false);
            });
        });

        it("should not intercept if url contains superTokensDoNotDoInterception", async function () {
            await startST(5);
            await setup();

            await page.evaluate(async () => {
                let userId = "testing-supertokens-website";

                // send api request to login
                let loginResponse = await toTest({
                    url: `/login#superTokensDoNotDoInterception`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ userId })
                });

                assert.strictEqual(loginResponse.responseText, userId);

                assert.strictEqual(await supertokens.doesSessionExist(), false);
            });
        });

        //cross domain login, userinfo, logout
        it("test cross domain", async () => {
            await startST(5);
            await setup();

            await page.evaluate(async () => {
                let userId = "testing-supertokens-website";

                // send api request to login
                let loginResponse = await toTest({
                    url: `${BASE_URL}/login`,
                    method: "post",
                    credentials: "include",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ userId })
                });

                //check that the userId which is returned in the response is the same as the one we sent
                assert.strictEqual(loginResponse.responseText, userId);

                // check that the session exists
                assert.strictEqual(await supertokens.doesSessionExist(), true);

                // check that the number of times session refresh is called is zero
                assert.strictEqual(await getNumberOfTimesRefreshCalled(BASE_URL), 0);

                //delay for 5 seconds so that we know accessToken expires

                await delay(5);
                // send a get session request , which should do a refresh session request
                let getSessionResponse = await toTest({ url: `${BASE_URL}/`, method: "get", credentials: "include" });

                // check that the getSession was successfull
                assert.strictEqual(getSessionResponse.responseText, userId);

                // check that the refresh session was called only once
                assert.strictEqual(await getNumberOfTimesRefreshCalled(BASE_URL), 1);

                // do logout
                let logoutResponse = await toTest({
                    url: `${BASE_URL}/logout`,
                    method: "post",
                    credentials: "include",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ userId })
                });
                assert.strictEqual(logoutResponse.responseText, "success");

                //check that session does not exist
                assert.strictEqual(await supertokens.doesSessionExist(), false);
            });
        });

        //cross domain login, userinfo, logout
        it("test cross domain, auto add credentials", async () => {
            await startST(5);
            await setup();
            await page.evaluate(async () => {
                let userId = "testing-supertokens-website";

                // send api request to login
                let loginResponse = await toTest({
                    url: `${BASE_URL}/login`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ userId })
                });

                //check that the userId which is returned in the response is the same as the one we sent
                assert.strictEqual(loginResponse.responseText, userId);

                // check that the session exists
                assert.strictEqual(await supertokens.doesSessionExist(), true);

                // check that the number of times session refresh is called is zero
                assert.strictEqual(await getNumberOfTimesRefreshCalled(BASE_URL), 0);

                //delay for 5 seconds so that we know accessToken expires

                await delay(5);
                // send a get session request , which should do a refresh session request
                let getSessionResponse = await toTest({ url: `${BASE_URL}/`, method: "get" });

                // check that the getSession was successfull
                assert.strictEqual(getSessionResponse.responseText, userId);

                // check that the refresh session was called only once
                assert.strictEqual(await getNumberOfTimesRefreshCalled(BASE_URL), 1);

                // do logout
                let logoutResponse = await toTest({
                    url: `${BASE_URL}/logout`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ userId })
                });
                assert.strictEqual(logoutResponse.responseText, "success");

                //check that session does not exist
                assert.strictEqual(await supertokens.doesSessionExist(), false);
            });
        });

        //cross domain login, userinfo, logout
        it("test cross domain, no auto add credentials, fail", async () => {
            await startST(5);
            await setup();
            await page.evaluate(async () => {
                let BASE_URL = "http://localhost.org:8082";
                supertokens.init({
                    apiDomain: BASE_URL,
                    autoAddCredentials: false
                });
                let userId = "testing-supertokens-website";

                // send api request to login
                let loginResponse = await toTest({
                    url: `${BASE_URL}/login`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ userId })
                });

                //check that the userId which is returned in the response is the same as the one we sent
                assert.strictEqual(loginResponse.responseText, userId);

                // check that the session exists
                assert.strictEqual(await supertokens.doesSessionExist(), true);

                // check that the number of times session refresh is called is zero
                assert.strictEqual(await getNumberOfTimesRefreshCalled(BASE_URL), 0);

                //delay for 5 seconds so that we know accessToken expires

                await delay(5);

                let resp = await toTest({ url: `${BASE_URL}/`, method: "get" });
                assert.strictEqual(resp.statusCode, 401);

                assert.strictEqual(await supertokens.doesSessionExist(), false);

                await toTest({
                    url: `${BASE_URL}/login`,
                    method: "post",
                    credentials: "include",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ userId })
                });

                // send a get session request , which should do a refresh session request
                let getSessionResponse = await toTest({ url: `${BASE_URL}/`, method: "get", credentials: "include" });

                // check that the getSession was successfull
                assert.strictEqual(getSessionResponse.responseText, userId);

                // check that the refresh session was called only once
                assert.strictEqual(await getNumberOfTimesRefreshCalled(BASE_URL), 0);

                // do logout
                let logoutResponse = await toTest({
                    url: `${BASE_URL}/logout`,
                    method: "post",
                    credentials: "include",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ userId })
                });
                assert.strictEqual(logoutResponse.responseText, "success");

                //check that session does not exist
                assert.strictEqual(await supertokens.doesSessionExist(), false);
            });
        });

        it("check sessionDoes exist calls refresh API just once", async function () {
            await startST();
            await setup();

            await page.evaluate(async () => {
                let userId = "testing-supertokens-website";

                // check document cookie = ""
                assert.strictEqual(document.cookie, "");

                // call sessionDoesExist
                assert.strictEqual(await supertokens.doesSessionExist(), false);

                // check refresh API was called once + document.cookie has removed
                assert.strictEqual(await getNumberOfTimesRefreshAttempted(), 1);
                assert.strictEqual(await getNumberOfTimesRefreshCalled(), 0);
                // assert.strictEqual(document.cookie, "sIRTFrontend=remove");

                // call sessionDoesExist
                assert.strictEqual(await supertokens.doesSessionExist(), false);
                // check refresh API not called
                assert.strictEqual(await getNumberOfTimesRefreshAttempted(), 1);
                assert.strictEqual(await getNumberOfTimesRefreshCalled(), 0);
                // assert.strictEqual(document.cookie, "sIRTFrontend=remove");

                await toTest({
                    url: `/login`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ userId })
                });

                // call sessionDoesExist
                assert.strictEqual(await supertokens.doesSessionExist(), true);
                // check refresh API not called
                assert.strictEqual(await getNumberOfTimesRefreshAttempted(), 1);
                assert.strictEqual(await getNumberOfTimesRefreshCalled(), 0);
                // assert.notEqual(document.cookie, "sIRTFrontend=remove");
            });
        });

        it("check clearing all frontend set cookies still works (without anti-csrf)", async function () {
            await startST(3, false);

            await setup();
            await page.evaluate(async () => {
                function deleteAllCookies() {
                    var cookies = document.cookie.split(";");

                    for (var i = 0; i < cookies.length; i++) {
                        var cookie = cookies[i];
                        var eqPos = cookie.indexOf("=");
                        var name = eqPos > -1 ? cookie.substr(0, eqPos) : cookie;
                        document.cookie = name + "=;expires=Thu, 01 Jan 1970 00:00:00 GMT";
                    }
                }

                let BASE_URL = "http://localhost.org:8080";
                supertokens.init({
                    apiDomain: BASE_URL
                });
                let userId = "testing-supertokens-website";

                // check document cookie = ""
                assert.strictEqual(document.cookie, "");

                await toTest({
                    url: `/login`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ userId })
                });

                // call sessionDoesExist
                assert.strictEqual(await supertokens.doesSessionExist(), true);
                // check refresh API not called
                assert.strictEqual(await getNumberOfTimesRefreshAttempted(), 1); // it's one here since it gets called during login..
                assert.strictEqual(await getNumberOfTimesRefreshCalled(), 0);
                // assert.notEqual(document.cookie, "sIRTFrontend=remove");

                // clear all cookies
                deleteAllCookies();
                // call sessionDoesExist (returns true) + call to refresh
                assert.strictEqual(await supertokens.doesSessionExist(), true);
                assert.strictEqual(await getNumberOfTimesRefreshAttempted(), 2);
                assert.strictEqual(await getNumberOfTimesRefreshCalled(), 1);

                // call sessionDoesExist (returns true) + no call to refresh
                assert.strictEqual(await supertokens.doesSessionExist(), true);
                assert.strictEqual(await getNumberOfTimesRefreshAttempted(), 2);
                assert.strictEqual(await getNumberOfTimesRefreshCalled(), 1);
            });
        });

        it("check clearing all frontend set cookies logs our user (with anti-csrf)", async function () {
            await startST();

            await setup();
            await page.evaluate(async () => {
                function deleteAllCookies() {
                    var cookies = document.cookie.split(";");

                    for (var i = 0; i < cookies.length; i++) {
                        var cookie = cookies[i];
                        var eqPos = cookie.indexOf("=");
                        var name = eqPos > -1 ? cookie.substr(0, eqPos) : cookie;
                        document.cookie = name + "=;expires=Thu, 01 Jan 1970 00:00:00 GMT";
                    }
                }

                let BASE_URL = "http://localhost.org:8080";
                supertokens.init({
                    apiDomain: BASE_URL
                });
                let userId = "testing-supertokens-website";

                // check document cookie = ""
                assert.strictEqual(document.cookie, "");

                await toTest({
                    url: `/login`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ userId })
                });

                // call sessionDoesExist
                assert.strictEqual(await supertokens.doesSessionExist(), true);
                // check refresh API not called
                assert.strictEqual(await getNumberOfTimesRefreshAttempted(), 1); // it's one here since it gets called during login..
                assert.strictEqual(await getNumberOfTimesRefreshCalled(), 0);
                // assert.notEqual(document.cookie, "sIRTFrontend=remove");

                // clear all cookies
                deleteAllCookies();
                // call sessionDoesExist (returns false) + call to refresh
                assert.strictEqual(await supertokens.doesSessionExist(), false);
                assert.strictEqual(await getNumberOfTimesRefreshAttempted(), 2);
                assert.strictEqual(await getNumberOfTimesRefreshCalled(), 0);

                // call sessionDoesExist (returns false) + no call to refresh
                assert.strictEqual(await supertokens.doesSessionExist(), false);
                assert.strictEqual(await getNumberOfTimesRefreshAttempted(), 2);
                assert.strictEqual(await getNumberOfTimesRefreshCalled(), 0);
            });
        });

        it("test that unauthorised event is not fired on initial page load", async function () {
            await startST();
            await setup();
            let consoleLogs = [];
            page.on("console", message => {
                if (message.text().startsWith("ST_")) {
                    consoleLogs.push(message.text());
                }
            });
            await page.evaluate(async () => {
                let BASE_URL = "http://localhost.org:8080";
                supertokens.init({
                    apiDomain: BASE_URL,
                    onHandleEvent: event => {
                        console.log("ST_" + event.action);
                    }
                });
                let userId = "testing-supertokens-website";

                let loginResponse = await toTest({
                    url: `${BASE_URL}/login`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ userId })
                });

                assert.strictEqual(loginResponse.responseText, userId);
            });
            assert.strictEqual(consoleLogs.length, 1);
            assert.strictEqual(consoleLogs[0], "ST_SESSION_CREATED");
        });

        it("test that unauthorised event is fired when calling protected route without a session", async function () {
            await startST();
            await setup();
            let consoleLogs = [];
            page.on("console", message => {
                if (message.text().startsWith("ST_")) {
                    consoleLogs.push(message.text());
                }
            });
            await page.evaluate(async () => {
                let BASE_URL = "http://localhost.org:8080";
                supertokens.init({
                    apiDomain: BASE_URL,
                    onHandleEvent: event => {
                        console.log(`ST_${event.action}:${JSON.stringify(event)}`);
                    }
                });
                let response = await toTest({ url: `${BASE_URL}/` });
                assert.strictEqual(response.statusCode, 401);
            });

            assert.strictEqual(consoleLogs.length, 1);

            const eventName = "ST_UNAUTHORISED";

            assert.strict(consoleLogs[0].startsWith(eventName));
            const parsedEvent = JSON.parse(consoleLogs[0].substr(eventName.length + 1));
            assert.strictEqual(parsedEvent.sessionExpiredOrRevoked, false);
        });

        it("test that setting headers works", async function () {
            await setup();
            const [_, req2, req3] = await Promise.all([
                page.evaluate(async () => {
                    let BASE_URL = "http://localhost.org:8080";
                    supertokens.init({
                        apiDomain: BASE_URL
                    });
                    await toTest({ url: `${BASE_URL}/test2`, headers: { asdf2: "123" } });
                    await toTest({ url: `${BASE_URL}/test3` });
                }),
                page.waitForRequest(`${BASE_URL}/test2`),
                page.waitForRequest(`${BASE_URL}/test3`)
            ]);

            assert.equal(req2.headers()["rid"], "anti-csrf");
            assert.equal(req2.headers()["asdf2"], "123");

            assert.equal(req3.headers()["rid"], "anti-csrf");
            assert.equal(req3.headers()["asdf"], undefined);
        });

        it("test that after login, and clearing all cookies, if we query a protected route, it fires unauthorised event", async function () {
            await startST();
            await setup();

            let consoleLogs = [];
            page.on("console", message => {
                if (message.text().startsWith("ST_")) {
                    consoleLogs.push(message.text());
                }
            });
            await page.evaluate(async () => {
                let BASE_URL = "http://localhost.org:8080";
                supertokens.init({
                    apiDomain: BASE_URL,
                    onHandleEvent: event => {
                        console.log(`ST_${event.action}:${JSON.stringify(event)}`);
                    }
                });
                let userId = "testing-supertokens-website";

                let loginResponse = await toTest({
                    url: `${BASE_URL}/login`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ userId })
                });

                assert.strictEqual(loginResponse.responseText, userId);
            });

            const client = await page.target().createCDPSession();
            await client.send("Network.clearBrowserCookies");
            await client.send("Network.clearBrowserCache");
            let cookies = await page.cookies();
            assert.strictEqual(cookies.length, 0);

            await page.evaluate(async () => {
                let BASE_URL = "http://localhost.org:8080";
                let response = await toTest({ url: `${BASE_URL}/` });
                assert.strictEqual(response.statusCode, 401);
            });

            assert.strictEqual(consoleLogs.length, 2);

            assert.strict(consoleLogs[0].startsWith("ST_SESSION_CREATED"));

            const eventName = "ST_UNAUTHORISED";
            assert.strict(consoleLogs[1].startsWith(eventName));
            const parsedEvent = JSON.parse(consoleLogs[1].substr(eventName.length + 1));
            assert.strictEqual(parsedEvent.sessionExpiredOrRevoked, false);
        });

        it("test that after login, and clearing only httpOnly cookies, if we query a protected route, it fires unauthorised event", async function () {
            if (transferMethod === "header") {
                // We skip this in header mode: it should work the same without httpOnly cookies
                this.skip();
            }
            await startST();
            await setup();
            let consoleLogs = [];
            page.on("console", message => {
                if (message.text().startsWith("ST_")) {
                    consoleLogs.push(message.text());
                }
            });
            await page.evaluate(async () => {
                let BASE_URL = "http://localhost.org:8080";
                supertokens.init({
                    apiDomain: BASE_URL,
                    onHandleEvent: event => {
                        console.log(`ST_${event.action}:${JSON.stringify(event)}`);
                    }
                });
                let userId = "testing-supertokens-website";

                let loginResponse = await toTest({
                    url: `${BASE_URL}/login`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ userId })
                });

                assert.strictEqual(loginResponse.responseText, userId);
            });

            let originalCookies = (await page.cookies()).filter(c => !c.httpOnly);

            const client = await page.target().createCDPSession();
            await client.send("Network.clearBrowserCookies");
            await client.send("Network.clearBrowserCache");

            await page.setCookie(...originalCookies);
            let cookies = await page.cookies();
            assert.strictEqual(cookies.length, 3);

            await page.evaluate(async () => {
                let BASE_URL = "http://localhost.org:8080";
                let response = await toTest({ url: `${BASE_URL}/` });
                assert.strictEqual(response.statusCode, 401);
            });

            assert.strictEqual(consoleLogs.length, 2);

            assert.strict(consoleLogs[0].startsWith("ST_SESSION_CREATED"));

            const eventName = "ST_UNAUTHORISED";
            assert.strict(consoleLogs[1].startsWith(eventName));
            const parsedEvent = JSON.parse(consoleLogs[1].substr(eventName.length + 1));
            assert.strict(parsedEvent.sessionExpiredOrRevoked);
        });

        it("refresh session with invalid tokens should clear all cookies", async function () {
            await startST();
            await setup();

            await page.evaluate(async () => {
                let userId = "testing-supertokens-website";
                let loginResponse = await toTest({
                    url: `${BASE_URL}/login`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ userId })
                });
            });

            // we save the cookies..
            let originalCookies = (await page._client.send("Network.getAllCookies")).cookies;

            // we logout
            await page.evaluate(async () => {
                let BASE_URL = "http://localhost.org:8080";
                await toTest({ url: `${BASE_URL}/logout`, method: "POST" });
            });

            // we set the old cookies with invalid access token
            originalCookies = originalCookies.map(c =>
                c.name === "sAccessToken" || c.name === "st-access-token" ? { ...c, value: "broken" } : c
            );
            await page.setCookie(...originalCookies);

            // now we expect a 401.
            await page.evaluate(async () => {
                let BASE_URL = "http://localhost.org:8080";
                let resp = await toTest({ url: `${BASE_URL}/`, method: "GET" });
                assert.strictEqual(resp.statusCode, 401);
                // assert.strictEqual(resp.url, `${BASE_URL}/auth/session/refresh`);
            });

            // and we assert that the only cookie that exists is the st-last-access-token-update
            let newCookies = (await page._client.send("Network.getAllCookies")).cookies;

            assert.strictEqual(newCookies.length, 1);
            assert.strictEqual(newCookies[0].name, "st-last-access-token-update");
        });

        it("refresh session endpoint responding with 500 makes the original call resolve with refresh response", async function () {
            await startST(100, true, "0.002");
            await setup();

            await page.setRequestInterception(true);
            let firstGet = true;
            let firstPost = true;
            page.on("request", req => {
                const url = req.url();
                if (url === BASE_URL + "/") {
                    if (firstGet) {
                        firstGet = false;
                        req.respond({
                            status: 401,
                            body: JSON.stringify({
                                message: "try refresh token"
                            })
                        });
                    } else {
                        req.respond({
                            status: 200,
                            body: JSON.stringify({
                                success: true
                            })
                        });
                    }
                } else if (url === BASE_URL + "/auth/session/refresh") {
                    if (firstPost) {
                        req.respond({
                            status: 401,
                            body: JSON.stringify({
                                message: "try refresh token"
                            })
                        });
                        firstPost = false;
                    } else {
                        req.respond({
                            status: 500,
                            body: JSON.stringify({
                                message: "test"
                            })
                        });
                    }
                } else {
                    req.continue();
                }
            });

            // page.on("console", l => console.log(l.text()));
            await page.evaluate(async () => {
                let BASE_URL = "http://localhost.org:8080";
                supertokens.init({
                    apiDomain: BASE_URL
                });
                let userId = "testing-supertokens-website";

                await toTest({
                    url: `${BASE_URL}/login`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ userId })
                });

                let response = await toTest({ url: `${BASE_URL}/`, method: "GET" });
                // assert.strictEqual(response.url, `${BASE_URL}/auth/session/refresh`);
                assert.strictEqual(response.statusCode, 500);
                const data = JSON.parse(response.responseText);
                assert.strictEqual(data.message, "test");
            });
        });

        it("no refresh call after 401 response that removes session", async function () {
            await startST(100, true, "0.002");
            await setup();
            await page.setRequestInterception(true);
            let refreshCalled = 0;
            page.on("request", req => {
                const url = req.url();
                if (url === BASE_URL + "/") {
                    req.respond({
                        status: 401,
                        body: JSON.stringify({ message: "test" }),
                        headers: {
                            // Cookies don't actually matter as long as we clear the front-token
                            // this is because the frontend will still have st-last-access-token-update w/ a removed front-token
                            // This is interpreted as a logged-out state
                            "front-token": "remove"
                        }
                    });
                } else if (url === BASE_URL + "/auth/session/refresh") {
                    ++refreshCalled;
                    req.respond({
                        status: 401,
                        body: JSON.stringify({ message: "nope" })
                    });
                } else {
                    req.continue();
                }
            });

            await page.evaluate(async () => {
                let userId = "testing-supertokens-website";
                await toTest({
                    url: `${BASE_URL}/login`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ userId })
                });

                const resp = await toTest({
                    url: `${BASE_URL}/`,
                    method: "GET",
                    headers: { "Cache-Control": "no-cache, private" }
                });

                assertNotEqual(resp, undefined);
                assert.strictEqual(resp.statusCode, 401);
                const data = JSON.parse(resp.responseText);
                assertNotEqual(data, undefined);
                assert.strictEqual(data.message, "test");
            });

            // Calls it once before login, but it shouldn't after that
            assert.equal(refreshCalled, 1);
        });

        it("original endpoint responding with 500 should not call refresh without cookies", async function () {
            await startST(100, true, "0.002");
            await setup();
            await page.setRequestInterception(true);
            let refreshCalled = 0;
            page.on("request", req => {
                const url = req.url();
                if (url === BASE_URL + "/") {
                    req.respond({
                        status: 500,
                        body: JSON.stringify({
                            message: "test"
                        })
                    });
                } else if (url === BASE_URL + "/auth/session/refresh") {
                    ++refreshCalled;
                    req.respond({
                        status: 500,
                        body: JSON.stringify({
                            message: "nope"
                        })
                    });
                } else {
                    req.continue();
                }
            });

            await page.evaluate(async () => {
                let response = await toTest({ url: `${BASE_URL}/`, method: "GET" });
                assert.strictEqual(response.url, `${BASE_URL}/`);
                assert.strictEqual(response.statusCode, 500);
                const data = JSON.parse(response.responseText);
                assert.strictEqual(data.message, "test");
            });
            // It should call it once before the call - but after that doesn't work it should not try again after the API request
            assert.strictEqual(refreshCalled, 1);
        });

        it("Test that the access token payload and the JWT have all valid claims after creating, refreshing and updating the payload", async function () {
            await startSTWithJWTEnabled();
            await setup();

            let isJwtEnabled = await checkIfJWTIsEnabled();

            if (!isJwtEnabled) {
                return;
            }

            await page.setRequestInterception(true);
            page.on("request", req => {
                const url = req.url();
                if (url === BASE_URL + "/jsondecode") {
                    let jwt = JSON.parse(req.postData()).jwt;
                    let decodedJWT = decodeJWT(jwt);

                    req.respond({
                        status: 200,
                        body: JSON.stringify(decodedJWT)
                    });
                } else {
                    req.continue();
                }
            });
            await page.evaluate(async v3AccessTokenSupported => {
                let BASE_URL = "http://localhost.org:8080";
                supertokens.init({
                    apiDomain: BASE_URL
                });

                let userId = "testing-supertokens-website";

                // Create a session
                let loginResponse = await toTest({
                    url: `${BASE_URL}/login`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ userId })
                });

                assert.strictEqual(loginResponse.responseText, userId);

                // Verify access token payload
                let accessTokenPayload = await supertokens.getAccessTokenPayloadSecurely();

                assertEqual(accessTokenPayload.customClaim, "customValue");
                let jwt;

                if (v3AccessTokenSupported) {
                    jwt = await supertokens.getAccessToken();
                    assertEqual(accessTokenPayload.jwt, undefined);
                    assertEqual(accessTokenPayload._jwtPName, undefined);
                } else {
                    assertNotEqual(accessTokenPayload.jwt, undefined);
                    assertEqual(accessTokenPayload.sub, undefined);
                    assertEqual(accessTokenPayload._jwtPName, "jwt");
                    assertEqual(accessTokenPayload.iss, undefined);

                    jwt = accessTokenPayload.jwt;
                }

                // Decode the JWT
                let decodeResponse = await toTest({
                    url: `${BASE_URL}/jsondecode`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ jwt })
                });

                let decodedJWT = JSON.parse(decodeResponse.responseText);

                // Verify the JWT claims
                assert.strictEqual(decodedJWT.sub, userId);
                assert.strictEqual(decodedJWT._jwtPName, undefined);
                assert.strictEqual(decodedJWT.iss, "http://0.0.0.0:8080/auth");
                assert.strictEqual(decodedJWT.customClaim, "customValue");

                // Update access token payload
                await toTest({
                    url: `${BASE_URL}/update-jwt`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ newClaim: "newValue" })
                });

                // Get access token payload
                accessTokenPayload = await supertokens.getAccessTokenPayloadSecurely();
                assertEqual(accessTokenPayload.customClaim, undefined);
                assertEqual(accessTokenPayload.newClaim, "newValue");

                // Verify new access token payload
                if (v3AccessTokenSupported) {
                    jwt = await supertokens.getAccessToken();
                    assertEqual(accessTokenPayload.jwt, undefined);
                    assertEqual(accessTokenPayload._jwtPName, undefined);
                } else {
                    assertNotEqual(accessTokenPayload.jwt, undefined);
                    assertEqual(accessTokenPayload.sub, undefined);
                    assertEqual(accessTokenPayload._jwtPName, "jwt");
                    assertEqual(accessTokenPayload.iss, undefined);

                    jwt = accessTokenPayload.jwt;
                }

                decodeResponse = await toTest({
                    url: `${BASE_URL}/jsondecode`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ jwt })
                });

                decodedJWT = JSON.parse(decodeResponse.responseText);

                // Verify new JWT
                assert.strictEqual(decodedJWT.sub, userId);
                assert.strictEqual(decodedJWT._jwtPName, undefined);
                assert.strictEqual(decodedJWT.customClaim, undefined);
                assert.strictEqual(decodedJWT.newClaim, "newValue");

                let attemptRefresh = await supertokens.attemptRefreshingSession();
                assert.strictEqual(attemptRefresh, true);

                // Verify new access token payload
                assertEqual(accessTokenPayload.customClaim, undefined);
                assertEqual(accessTokenPayload.newClaim, "newValue");

                // Verify new access token payload
                if (v3AccessTokenSupported) {
                    jwt = await supertokens.getAccessToken();
                    assertEqual(accessTokenPayload.jwt, undefined);
                    assertEqual(accessTokenPayload._jwtPName, undefined);
                } else {
                    assertNotEqual(accessTokenPayload.jwt, undefined);
                    assertEqual(accessTokenPayload.sub, undefined);
                    assertEqual(accessTokenPayload._jwtPName, "jwt");
                    assertEqual(accessTokenPayload.iss, undefined);

                    jwt = accessTokenPayload.jwt;
                }

                decodeResponse = await toTest({
                    url: `${BASE_URL}/jsondecode`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ jwt })
                });

                decodedJWT = JSON.parse(decodeResponse.responseText);

                // Verify new JWT
                assert.strictEqual(decodedJWT.sub, userId);
                assert.strictEqual(decodedJWT._jwtPName, undefined);
                assert.strictEqual(decodedJWT.customClaim, undefined);
                assert.strictEqual(decodedJWT.newClaim, "newValue");
            }, v3AccessTokenSupported);
        });

        it("Test that the access token payload and the JWT have all valid claims after updating access token payload", async function () {
            await startSTWithJWTEnabled();

            let isJwtEnabled = await checkIfJWTIsEnabled();

            if (!isJwtEnabled) {
                return;
            }

            await setup();
            await page.setRequestInterception(true);
            page.on("request", req => {
                const url = req.url();
                if (url === BASE_URL + "/jsondecode") {
                    let jwt = JSON.parse(req.postData()).jwt;
                    let decodedJWT = decodeJWT(jwt);

                    req.respond({
                        status: 200,
                        body: JSON.stringify(decodedJWT)
                    });
                } else {
                    req.continue();
                }
            });
            await page.evaluate(async v3AccessTokenSupported => {
                let BASE_URL = "http://localhost.org:8080";
                supertokens.init({
                    apiDomain: BASE_URL
                });

                let userId = "testing-supertokens-website";

                // Create a session
                let loginResponse = await toTest({
                    url: `${BASE_URL}/login`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ userId })
                });

                assert.strictEqual(loginResponse.responseText, userId);

                // Verify access token payload
                let accessTokenPayload = await supertokens.getAccessTokenPayloadSecurely();
                assertEqual(accessTokenPayload.customClaim, "customValue");
                let jwt;

                if (v3AccessTokenSupported) {
                    jwt = await supertokens.getAccessToken();
                    assertEqual(accessTokenPayload.jwt, undefined);
                    assertEqual(accessTokenPayload._jwtPName, undefined);
                } else {
                    assertNotEqual(accessTokenPayload.jwt, undefined);
                    assertEqual(accessTokenPayload.sub, undefined);
                    assertEqual(accessTokenPayload._jwtPName, "jwt");
                    assertEqual(accessTokenPayload.iss, undefined);

                    jwt = accessTokenPayload.jwt;
                }

                // Decode the JWT
                let decodeResponse = await toTest({
                    url: `${BASE_URL}/jsondecode`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ jwt })
                });

                let decodedJWT = JSON.parse(decodeResponse.responseText);

                // Verify the JWT claims
                assert.strictEqual(decodedJWT.sub, userId);
                assert.strictEqual(decodedJWT._jwtPName, undefined);
                assert.strictEqual(decodedJWT.iss, "http://0.0.0.0:8080/auth");
                assert.strictEqual(decodedJWT.customClaim, "customValue");

                // Update access token payload
                await toTest({
                    url: `${BASE_URL}/update-jwt`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        customClaim: undefined,
                        newClaim: "newValue"
                    })
                });

                // Get access token payload
                accessTokenPayload = await supertokens.getAccessTokenPayloadSecurely();
                assert.strictEqual(accessTokenPayload.customClaim, undefined);
                assert.strictEqual(accessTokenPayload.newClaim, "newValue");

                if (v3AccessTokenSupported) {
                    jwt = await supertokens.getAccessToken();
                    assertEqual(accessTokenPayload.jwt, undefined);
                    assertEqual(accessTokenPayload._jwtPName, undefined);
                } else {
                    assertNotEqual(accessTokenPayload.jwt, undefined);
                    assertEqual(accessTokenPayload.sub, undefined);
                    assertEqual(accessTokenPayload._jwtPName, "jwt");
                    assertEqual(accessTokenPayload.iss, undefined);

                    jwt = accessTokenPayload.jwt;
                }

                decodeResponse = await toTest({
                    url: `${BASE_URL}/jsondecode`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ jwt })
                });

                decodedJWT = JSON.parse(decodeResponse.responseText);

                // Verify new JWT
                assert.strictEqual(decodedJWT.sub, userId);
                assert.strictEqual(decodedJWT._jwtPName, undefined);
                assert.strictEqual(decodedJWT.customClaim, undefined);
                assert.strictEqual(decodedJWT.newClaim, "newValue");
            }, v3AccessTokenSupported);
        });

        it("Test that access token payload and JWT are valid after the property name changes and payload is updated", async function () {
            await startSTWithJWTEnabled();

            let isJwtEnabled = await checkIfJWTIsEnabled();

            if (!isJwtEnabled || v3AccessTokenSupported) {
                return;
            }

            await setup();
            await page.setRequestInterception(true);
            page.on("request", req => {
                const url = req.url();
                if (url === BASE_URL + "/jsondecode") {
                    let jwt = JSON.parse(req.postData()).jwt;
                    let decodedJWT = decodeJWT(jwt);

                    req.respond({
                        status: 200,
                        body: JSON.stringify(decodedJWT)
                    });
                } else {
                    req.continue();
                }
            });
            await page.evaluate(async () => {
                let BASE_URL = "http://localhost.org:8080";
                supertokens.init({
                    apiDomain: BASE_URL
                });

                let userId = "testing-supertokens-website";

                // Create a session
                let loginResponse = await toTest({
                    url: `${BASE_URL}/login`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ userId })
                });

                assert.strictEqual(loginResponse.responseText, userId);

                // Verify access token payload
                let accessTokenPayload = await supertokens.getAccessTokenPayloadSecurely();

                assertNotEqual(accessTokenPayload.jwt, undefined);
                assert.strictEqual(accessTokenPayload.sub, undefined);
                assert.strictEqual(accessTokenPayload._jwtPName, "jwt");
                assert.strictEqual(accessTokenPayload.iss, undefined);
                assert.strictEqual(accessTokenPayload.customClaim, "customValue");

                let jwt = accessTokenPayload.jwt;

                // Decode the JWT
                let decodeResponse = await toTest({
                    url: `${BASE_URL}/jsondecode`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ jwt })
                });

                let decodedJWT = JSON.parse(decodeResponse.responseText);

                // Verify the JWT claims
                assert.strictEqual(decodedJWT.sub, userId);
                assert.strictEqual(decodedJWT._jwtPName, undefined);
                assert.strictEqual(decodedJWT.iss, "http://0.0.0.0:8080/auth");
                assert.strictEqual(decodedJWT.customClaim, "customValue");

                await toTest({
                    url: `${BASE_URL}/reinitialiseBackendConfig`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        jwtPropertyName: "customJWTProperty"
                    })
                });

                // Update access token payload
                await toTest({
                    url: `${BASE_URL}/update-jwt`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ newClaim: "newValue" })
                });

                // Get access token payload
                accessTokenPayload = await supertokens.getAccessTokenPayloadSecurely();

                // Verify new access token payload
                assertNotEqual(accessTokenPayload.jwt, undefined);
                assert.strictEqual(accessTokenPayload.sub, undefined);
                assert.strictEqual(accessTokenPayload._jwtPName, "jwt");
                assert.strictEqual(accessTokenPayload.iss, undefined);
                assert.strictEqual(accessTokenPayload.customClaim, undefined);
                assert.strictEqual(accessTokenPayload.customJWTProperty, undefined);
                assert.strictEqual(accessTokenPayload.newClaim, "newValue");

                jwt = accessTokenPayload.jwt;

                decodeResponse = await toTest({
                    url: `${BASE_URL}/jsondecode`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ jwt })
                });

                decodedJWT = JSON.parse(decodeResponse.responseText);

                // Verify new JWT
                assert.strictEqual(decodedJWT.sub, userId);
                assert.strictEqual(decodedJWT._jwtPName, undefined);
                assert.strictEqual(decodedJWT.iss, "http://0.0.0.0:8080/auth");
                assert.strictEqual(decodedJWT.customClaim, undefined);
                assert.strictEqual(decodedJWT.newClaim, "newValue");
            });
        });

        it("Test that access token payload and JWT are valid after the property name changes and session is refreshed", async function () {
            await startSTWithJWTEnabled();

            let isJwtEnabled = await checkIfJWTIsEnabled();

            if (!isJwtEnabled || v3AccessTokenSupported) {
                return;
            }

            await setup();
            await page.setRequestInterception(true);
            page.on("request", req => {
                const url = req.url();
                if (url === BASE_URL + "/jsondecode") {
                    let jwt = JSON.parse(req.postData()).jwt;
                    let decodedJWT = decodeJWT(jwt);

                    req.respond({
                        status: 200,
                        body: JSON.stringify(decodedJWT)
                    });
                } else {
                    req.continue();
                }
            });
            await page.evaluate(async () => {
                let BASE_URL = "http://localhost.org:8080";
                supertokens.init({
                    apiDomain: BASE_URL
                });

                let userId = "testing-supertokens-website";

                // Create a session
                let loginResponse = await toTest({
                    url: `${BASE_URL}/login`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ userId })
                });

                assert.strictEqual(loginResponse.responseText, userId);

                // Verify access token payload
                let accessTokenPayload = await supertokens.getAccessTokenPayloadSecurely();

                assertNotEqual(accessTokenPayload.jwt, undefined);
                assert.strictEqual(accessTokenPayload.sub, undefined);
                assert.strictEqual(accessTokenPayload._jwtPName, "jwt");
                assert.strictEqual(accessTokenPayload.iss, undefined);
                assert.strictEqual(accessTokenPayload.customClaim, "customValue");

                let jwt = accessTokenPayload.jwt;

                // Decode the JWT
                let decodeResponse = await toTest({
                    url: `${BASE_URL}/jsondecode`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ jwt })
                });

                let decodedJWT = JSON.parse(decodeResponse.responseText);

                // Verify the JWT claims
                assert.strictEqual(decodedJWT.sub, userId);
                assert.strictEqual(decodedJWT._jwtPName, undefined);
                assert.strictEqual(decodedJWT.iss, "http://0.0.0.0:8080/auth");
                assert.strictEqual(decodedJWT.customClaim, "customValue");

                await toTest({
                    url: `${BASE_URL}/reinitialiseBackendConfig`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        jwtPropertyName: "customJWTProperty"
                    })
                });

                let attemptRefresh = await supertokens.attemptRefreshingSession();
                assert.strictEqual(attemptRefresh, true);

                // Get access token payload
                accessTokenPayload = await supertokens.getAccessTokenPayloadSecurely();

                // Verify new access token payload
                assert.strictEqual(accessTokenPayload.jwt, undefined);
                assertNotEqual(accessTokenPayload.customJWTProperty, undefined);
                assert.strictEqual(accessTokenPayload.sub, undefined);
                assert.strictEqual(accessTokenPayload._jwtPName, "customJWTProperty");
                assert.strictEqual(accessTokenPayload.iss, undefined);
                assert.strictEqual(accessTokenPayload.customClaim, "customValue");

                jwt = accessTokenPayload.customJWTProperty;

                decodeResponse = await toTest({
                    url: `${BASE_URL}/jsondecode`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ jwt })
                });

                decodedJWT = JSON.parse(decodeResponse.responseText);

                // Verify new JWT
                assert.strictEqual(decodedJWT.sub, userId);
                assert.strictEqual(decodedJWT._jwtPName, undefined);
                assert.strictEqual(decodedJWT.iss, "http://0.0.0.0:8080/auth");
                assert.strictEqual(decodedJWT.customClaim, "customValue");
            });
        });

        it("Test that access token payload and jwt are valid after the session has expired", async function () {
            await startSTWithJWTEnabled(3);

            let isJwtEnabled = await checkIfJWTIsEnabled();

            if (!isJwtEnabled) {
                return;
            }

            await setup();
            await page.setRequestInterception(true);
            page.on("request", req => {
                const url = req.url();
                if (url === BASE_URL + "/jsondecode") {
                    let jwt = JSON.parse(req.postData()).jwt;
                    let decodedJWT = decodeJWT(jwt);

                    req.respond({
                        status: 200,
                        body: JSON.stringify(decodedJWT)
                    });
                } else {
                    req.continue();
                }
            });
            await page.evaluate(async v3AccessTokenSupported => {
                let BASE_URL = "http://localhost.org:8080";
                supertokens.init({
                    apiDomain: BASE_URL
                });

                let userId = "testing-supertokens-website";

                // Create a session
                let loginResponse = await toTest({
                    url: `${BASE_URL}/login`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ userId })
                });

                assert.strictEqual(loginResponse.responseText, userId);

                // Verify access token payload
                let accessTokenPayload = await supertokens.getAccessTokenPayloadSecurely();
                assert.strictEqual(accessTokenPayload.customClaim, "customValue");

                let jwt;

                if (v3AccessTokenSupported) {
                    jwt = await supertokens.getAccessToken();
                    assertEqual(accessTokenPayload.jwt, undefined);
                    assertEqual(accessTokenPayload._jwtPName, undefined);
                } else {
                    assertNotEqual(accessTokenPayload.jwt, undefined);
                    assertEqual(accessTokenPayload.sub, undefined);
                    assertEqual(accessTokenPayload._jwtPName, "jwt");
                    assertEqual(accessTokenPayload.iss, undefined);

                    jwt = accessTokenPayload.jwt;
                }

                let decodeResponse = await toTest({
                    url: `${BASE_URL}/jsondecode`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ jwt })
                });

                let decodedJWT = JSON.parse(decodeResponse.responseText);

                let jwtExpiry = decodedJWT.exp;

                // Wait for access token to expire
                await delay(5);

                assert.strictEqual(await getNumberOfTimesRefreshCalled(), 0);

                accessTokenPayload = await supertokens.getAccessTokenPayloadSecurely();

                assert.strictEqual(await getNumberOfTimesRefreshCalled(), 1);

                assert.strictEqual(accessTokenPayload.customClaim, "customValue");

                if (v3AccessTokenSupported) {
                    jwt = await supertokens.getAccessToken();
                    assertEqual(accessTokenPayload.jwt, undefined);
                    assertEqual(accessTokenPayload._jwtPName, undefined);
                } else {
                    assertNotEqual(accessTokenPayload.jwt, undefined);
                    assertEqual(accessTokenPayload.sub, undefined);
                    assertEqual(accessTokenPayload._jwtPName, "jwt");
                    assertEqual(accessTokenPayload.iss, undefined);

                    jwt = accessTokenPayload.jwt;
                }

                decodeResponse = await toTest({
                    url: `${BASE_URL}/jsondecode`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ jwt })
                });

                decodedJWT = JSON.parse(decodeResponse.responseText);

                // Verify new JWT
                assert.strictEqual(decodedJWT.sub, userId);
                assert.strictEqual(decodedJWT._jwtPName, undefined);
                assert.strictEqual(decodedJWT.iss, "http://0.0.0.0:8080/auth");
                assert.strictEqual(decodedJWT.customClaim, "customValue");

                let newJwtExpiry = decodedJWT.exp;

                assert.strictEqual(newJwtExpiry > Math.ceil(Date.now() / 1000), true);
                assertNotEqual(jwtExpiry, newJwtExpiry);
            }, v3AccessTokenSupported);
        });

        it("Test full JWT flow with open id discovery", async function () {
            await startSTWithJWTEnabled(20);

            let isJwtEnabled = await checkIfJWTIsEnabled();

            if (!isJwtEnabled) {
                return;
            }

            await page.setRequestInterception(true);
            page.on("request", req => {
                const url = req.url();
                if (url === BASE_URL + "/jsondecode") {
                    let jwt = JSON.parse(req.postData()).jwt;
                    let decodedJWT = decodeJWT(jwt);

                    req.respond({
                        status: 200,
                        body: JSON.stringify(decodedJWT)
                    });
                } else if (url === BASE_URL + "/jwtVerify") {
                    let data = JSON.parse(req.postData());
                    let jwt = data.jwt;
                    let jwksURL = data.jwksURL;
                    let client = jwksClient({
                        jwksUri: jwksURL
                    });

                    function getKey(header, callback) {
                        client.getSigningKey(header.kid, function (err, key) {
                            if (err) {
                                callback(err, null);
                                return;
                            }

                            var signingKey = key.publicKey || key.rsaPublicKey;
                            callback(null, signingKey);
                        });
                    }

                    verifyJWT(jwt, getKey, (err, decoded) => {
                        if (err) {
                            req.respond({
                                status: 500,
                                body: JSON.stringify({
                                    error: err
                                })
                            });
                            return;
                        }

                        req.respond({
                            status: 200,
                            body: JSON.stringify(decoded)
                        });
                    });
                } else {
                    req.continue();
                }
            });
            await setup();
            await page.evaluate(async v3AccessTokenSupported => {
                let userId = "testing-supertokens-website";

                // Create a session
                let loginResponse = await toTest({
                    url: `${BASE_URL}/login`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ userId })
                });

                assert.strictEqual(loginResponse.responseText, userId);

                // Verify access token payload
                let accessTokenPayload = await supertokens.getAccessTokenPayloadSecurely();
                assert.strictEqual(accessTokenPayload.customClaim, "customValue");

                let jwt;

                if (v3AccessTokenSupported) {
                    jwt = await supertokens.getAccessToken();
                    assertEqual(accessTokenPayload.jwt, undefined);
                    assertEqual(accessTokenPayload._jwtPName, undefined);
                } else {
                    assertNotEqual(accessTokenPayload.jwt, undefined);
                    assertEqual(accessTokenPayload.sub, undefined);
                    assertEqual(accessTokenPayload._jwtPName, "jwt");
                    assertEqual(accessTokenPayload.iss, undefined);

                    jwt = accessTokenPayload.jwt;
                }

                let decodeResponse = await toTest({
                    url: `${BASE_URL}/jsondecode`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ jwt })
                });

                let decodedJWT = JSON.parse(decodeResponse.responseText);

                // Verify the JWT claims
                assert.strictEqual(decodedJWT.sub, userId);
                assert.strictEqual(decodedJWT._jwtPName, undefined);
                assert.strictEqual(decodedJWT.iss, "http://0.0.0.0:8080/auth");
                assert.strictEqual(decodedJWT.customClaim, "customValue");

                // Use the jwt issuer to get discovery configuration

                let discoveryEndpoint = decodedJWT.iss + "/.well-known/openid-configuration";

                let jwksEndpoint = (await (await fetch(discoveryEndpoint)).json()).jwks_uri;

                let verifyResponse = await toTest({
                    url: `${BASE_URL}/jwtVerify`,
                    method: "POST",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        jwt,
                        jwksURL: jwksEndpoint
                    })
                });

                if (verifyResponse.statusCode !== 200) {
                    throw new Error("JWT Verification failed");
                }

                decodedJWT = JSON.parse(verifyResponse.responseText);

                assert.strictEqual(decodedJWT.sub, userId);
                assert.strictEqual(decodedJWT._jwtPName, undefined);
                assert.strictEqual(decodedJWT.iss, "http://0.0.0.0:8080/auth");
                assert.strictEqual(decodedJWT.customClaim, "customValue");
            }, v3AccessTokenSupported);
        });

        it("test when ACCESS_TOKEN_PAYLOAD_UPDATED is fired", async function () {
            await startST(3);

            await setup();
            const logs = [];
            page.on("console", ev => {
                const logText = ev.text();
                if (logText.startsWith("TEST_EV$")) {
                    logs.push(logText.split("$")[1]);
                }
            });
            await page.evaluate(async () => {
                supertokens.init({
                    apiDomain: BASE_URL,
                    onHandleEvent: ev => console.log(`TEST_EV$${ev.action}`)
                });

                let userId = "testing-supertokens-website";

                await toTest({
                    url: `${BASE_URL}/login`,
                    method: "POST",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ userId })
                });
                console.log("TEST_EV$LOGIN_FINISH");
                await toTest({
                    url: `${BASE_URL}/update-jwt`,
                    method: "POST",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ test: 1 })
                });
                console.log("TEST_EV$UPDATE1_FINISH");
                await delay(5);
                await toTest({
                    url: `${BASE_URL}/`,
                    method: "GET",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    }
                });
                console.log("TEST_EV$REFRESH_FINISH");

                await toTest({
                    url: `${BASE_URL}/update-jwt`,
                    method: "POST",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ test: 2 })
                });
                console.log("TEST_EV$UPDATE2_FINISH");
                assertEqual((await supertokens.getAccessTokenPayloadSecurely()).test, 2);
                await delay(5);

                await toTest({
                    url: `${BASE_URL}/update-jwt`,
                    method: "POST",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ test: 3 })
                });
                assertEqual((await supertokens.getAccessTokenPayloadSecurely()).test, 3);
                console.log("TEST_EV$UPDATE3_FINISH");

                await toTest({
                    url: `${BASE_URL}/logout`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ userId })
                });
            });
            if (v3AccessTokenSupported) {
                assert.deepEqual(logs, [
                    "SESSION_CREATED",
                    "LOGIN_FINISH",
                    "ACCESS_TOKEN_PAYLOAD_UPDATED", // Normal update triggered by the endpoint changing the payload
                    "UPDATE1_FINISH",
                    "ACCESS_TOKEN_PAYLOAD_UPDATED", // The refresh endpoint updates the access token
                    "REFRESH_SESSION",
                    "ACCESS_TOKEN_PAYLOAD_UPDATED", // The first request after the refresh (i.e.: during retry) also updates it
                    "REFRESH_FINISH",
                    "ACCESS_TOKEN_PAYLOAD_UPDATED", // Normal update triggered by the endpoint changing the payload
                    "UPDATE2_FINISH",
                    "ACCESS_TOKEN_PAYLOAD_UPDATED", // This is from refresh updating the token
                    "REFRESH_SESSION",
                    "ACCESS_TOKEN_PAYLOAD_UPDATED", // Normal update triggered by the (retried) endpoint changing the payload
                    "UPDATE3_FINISH",
                    "SIGN_OUT"
                ]);
            } else {
                assert.deepEqual(logs, [
                    "SESSION_CREATED",
                    "LOGIN_FINISH",
                    "ACCESS_TOKEN_PAYLOAD_UPDATED", // Normal update triggered by the endpoint changing the payload
                    "UPDATE1_FINISH",
                    "REFRESH_SESSION",
                    "REFRESH_FINISH",
                    "ACCESS_TOKEN_PAYLOAD_UPDATED", // Normal update triggered by the endpoint changing the payload
                    "UPDATE2_FINISH",
                    "REFRESH_SESSION",
                    "ACCESS_TOKEN_PAYLOAD_UPDATED", // Normal update triggered by the (retried) endpoint changing the payload
                    "UPDATE3_FINISH",
                    "SIGN_OUT"
                ]);
            }
        });

        it("test ACCESS_TOKEN_PAYLOAD_UPDATED when updated with handle", async function () {
            await startST(3);

            await setup();
            const logs = [];
            page.on("console", ev => {
                const logText = ev.text();
                if (logText.startsWith("TEST_EV$")) {
                    logs.push(logText.split("$")[1]);
                }
            });
            await page.evaluate(async () => {
                let userId = "testing-supertokens-website";
                supertokens.init({
                    apiDomain: BASE_URL,
                    onHandleEvent: ev => console.log(`TEST_EV$${ev.action}`)
                });

                await toTest({
                    url: `${BASE_URL}/login`,
                    method: "POST",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ userId })
                });
                console.log("TEST_EV$LOGIN_FINISH");

                await toTest({
                    url: `${BASE_URL}/update-jwt-with-handle`,
                    method: "POST",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ test: 2 })
                });
                console.log("TEST_EV$PAYLOAD_DB_UPDATED");
                await toTest({
                    url: `${BASE_URL}/`,
                    method: "GET",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    }
                });
                console.log("TEST_EV$QUERY_NO_REFRESH");
                await delay(5);

                await toTest({
                    url: `${BASE_URL}/`,
                    method: "GET",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    }
                });
                console.log("TEST_EV$REFRESH_FINISH");

                await toTest({
                    url: `${BASE_URL}/logout`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ userId })
                });
            });
            if (v3AccessTokenSupported) {
                assert.deepEqual(logs, [
                    "SESSION_CREATED",
                    "LOGIN_FINISH",
                    "PAYLOAD_DB_UPDATED",
                    "QUERY_NO_REFRESH",
                    "ACCESS_TOKEN_PAYLOAD_UPDATED",
                    "REFRESH_SESSION",
                    "ACCESS_TOKEN_PAYLOAD_UPDATED", // The first request after the refresh also triggers the update
                    "REFRESH_FINISH",
                    "SIGN_OUT"
                ]);
            } else {
                assert.deepEqual(logs, [
                    "SESSION_CREATED",
                    "LOGIN_FINISH",
                    "PAYLOAD_DB_UPDATED",
                    "QUERY_NO_REFRESH",
                    "ACCESS_TOKEN_PAYLOAD_UPDATED",
                    "REFRESH_SESSION",
                    "REFRESH_FINISH",
                    "SIGN_OUT"
                ]);
            }
        });

        it("Test that everything works if the user reads the body and headers in the post API hook", async function () {
            await startST();

            await setup();
            await page.evaluate(async () => {
                supertokens.init({
                    apiDomain: BASE_URL,
                    postAPIHook: async context => {
                        assert.strictEqual(context.action === "REFRESH_SESSION" || context.action === "SIGN_OUT", true);

                        if (context.action === "REFRESH_SESSION" && context.fetchResponse.statusCode === 200) {
                            const body = await context.fetchResponse.text();
                            assert.strictEqual(body, "refresh success");

                            const frontTokenInHeader = context.fetchResponse.headers.get("front-token");
                            assertNotEqual(frontTokenInHeader, "");
                            assertNotEqual(frontTokenInHeader, null);
                        }

                        if (context.action === "SIGN_OUT" && context.fetchResponse.statusCode === 200) {
                            const body = await context.fetchResponse.json();
                            assert.strictEqual(body.statusCode, "OK");

                            const frontTokenInHeader = context.fetchResponse.headers.get("front-token");
                            assert.strictEqual(frontTokenInHeader, "remove");
                        }
                    }
                });
                let userId = "testing-supertokens-website";

                let loginResponse = await toTest({
                    url: `${BASE_URL}/login`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ userId })
                });

                assert.strictEqual(loginResponse.responseText, userId);
                assert.strictEqual(await getNumberOfTimesRefreshCalled(), 0);

                await delay(2);
                let attemptRefresh = await supertokens.attemptRefreshingSession();
                assert.strictEqual(attemptRefresh, true);

                assert.strictEqual(await getNumberOfTimesRefreshCalled(), 1);
                await supertokens.signOut();
                assert.strictEqual(await getNumberOfTimesRefreshCalled(), 1);
                assert.strictEqual(await supertokens.doesSessionExist(), false);
            });
        });

        it("test disabled interception", async function () {
            await startST();

            await setup();
            await page.evaluate(async () => {
                supertokens.init({
                    apiDomain: BASE_URL,
                    postAPIHook: async context => {
                        assert.strictEqual(context.action === "REFRESH_SESSION" || context.action === "SIGN_OUT", true);

                        if (context.action === "REFRESH_SESSION" && context.fetchResponse.statusCode === 200) {
                            const body = await context.fetchResponse.text();
                            assert.strictEqual(body, "refresh success");

                            const frontTokenInHeader = context.fetchResponse.headers.get("front-token");
                            assertNotEqual(frontTokenInHeader, "");
                            assertNotEqual(frontTokenInHeader, null);
                        }

                        if (context.action === "SIGN_OUT" && context.fetchResponse.statusCode === 200) {
                            const body = await context.fetchResponse.json();
                            assert.strictEqual(body.statusCode, "OK");

                            const frontTokenInHeader = context.fetchResponse.headers.get("front-token");
                            assert.strictEqual(frontTokenInHeader, "remove");
                        }
                    }
                });
                let userId = "testing-supertokens-website";

                let loginResponse = await toTest({
                    url: `${BASE_URL}/login`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ userId })
                });

                assert.strictEqual(loginResponse.responseText, userId);
                assert.strictEqual(await getNumberOfTimesRefreshCalled(), 0);

                await delay(2);
                let attemptRefresh = await supertokens.attemptRefreshingSession();
                assert.strictEqual(attemptRefresh, true);

                assert.strictEqual(await getNumberOfTimesRefreshCalled(), 1);
                await supertokens.signOut();
                assert.strictEqual(await getNumberOfTimesRefreshCalled(), 1);
                assert.strictEqual(await supertokens.doesSessionExist(), false);
            });
        });

        it("should work after refresh migrating old cookie based sessions", async function () {
            if (transferMethod === "header") {
                // We skip this in header mode, they can't have legacy sessions
                this.skip();
            }

            await startST();
            await setup();

            await page.evaluate(async () => {
                let userId = "testing-supertokens-website";
                let loginResponse = await toTest({
                    url: `${BASE_URL}/login`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ userId })
                });
            });

            await page.setCookie({ name: "sIdRefreshToken", value: "asdf" });

            assert.strictEqual(await getNumberOfTimesRefreshCalled(), 0);
            let originalCookies = (await page._client.send("Network.getAllCookies")).cookies;
            assert.notStrictEqual(
                originalCookies.find(cookie => cookie.name === "sIdRefreshToken"),
                undefined
            );

            await page.evaluate(async () => {
                let BASE_URL = "http://localhost.org:8080";
                let resp = await toTest({ url: `${BASE_URL}/`, method: "GET" });
                assert.strictEqual(resp.statusCode, 200);
            });
            assert.strictEqual(await getNumberOfTimesRefreshCalled(), 1);
            let newCookies = (await page._client.send("Network.getAllCookies")).cookies;
            assert.strictEqual(
                newCookies.find(cookie => cookie.name === "sIdRefreshToken"),
                undefined
            );
        });

        it("should work after refresh migrating old cookie based sessions with expired access tokens", async function () {
            if (transferMethod === "header") {
                // We skip this in header mode, they can't have legacy sessions
                this.skip();
            }

            await startST();
            await setup();

            await page.evaluate(async () => {
                let userId = "testing-supertokens-website";
                let loginResponse = await toTest({
                    url: `${BASE_URL}/login`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ userId })
                });
            });

            // This would work even without sIdRefreshToken since we don't actually check the body of the response, just call refresh on all 401s
            await page.setCookie({ name: "sIdRefreshToken", value: "asdf" });
            await page.setCookie({ name: "sAccessToken", value: "", expiry: 0 });

            assert.strictEqual(await getNumberOfTimesRefreshCalled(), 0);
            let originalCookies = (await page._client.send("Network.getAllCookies")).cookies;
            assert.notStrictEqual(
                originalCookies.find(cookie => cookie.name === "sIdRefreshToken"),
                undefined
            );

            await page.evaluate(async () => {
                let BASE_URL = "http://localhost.org:8080";
                let resp = await toTest({ url: `${BASE_URL}/`, method: "GET" });
                assert.strictEqual(resp.statusCode, 200);
            });
            assert.strictEqual(await getNumberOfTimesRefreshCalled(), 1);
            let newCookies = (await page._client.send("Network.getAllCookies")).cookies;
            assert.notStrictEqual(
                originalCookies.find(cookie => cookie.name === "sAccessToken"),
                undefined
            );
            assert.strictEqual(
                newCookies.find(cookie => cookie.name === "sIdRefreshToken"),
                undefined
            );
        });

        /**
         * - Create a session with cookies and add sIdRefreshToken manually to simulate old cookies
         * - Change the token method to headers
         * - Get session information and make sure the API succeeds, refresh is called and sIdRefreshToken is removed
         * - Make sure getAccessToken returns undefined because the backend should have used cookies
         * - Sign out
         * - Login again and make sure access token is present because backend should now use headers
         */
        it("should still work fine work fine if header based auth is enabled after a cookie based session", async function () {
            if (transferMethod === "header") {
                // We skip this in header mode, they can't have legacy sessions
                this.skip();
            }

            await startST();
            await setup();

            await page.evaluate(async () => {
                window.userId = "testing-supertokens";
                window.BASE_URL = "http://localhost.org:8080";

                // send api request to login
                let loginResponse = await toTest({
                    url: `${BASE_URL}/login`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ userId })
                });

                assert.strictEqual(loginResponse.responseText, userId);

                // make sure there is no access token
                let accessToken = await supertokens.getAccessToken();
                assert.strictEqual(accessToken, undefined);

                let getSessionResponse = await toTest({
                    url: `${BASE_URL}/`,
                    headers: {
                        Authorization: `Bearer ${accessToken}`
                    }
                });

                assert.strictEqual(getSessionResponse.statusCode, 200);
                assert.strictEqual(getSessionResponse.responseText, userId);
            });

            // This would work even without sIdRefreshToken since we don't actually check the body of the response, just call refresh on all 401s
            await page.setCookie({ name: "sIdRefreshToken", value: "asdf" });

            const originalCookies = (await page._client.send("Network.getAllCookies")).cookies;
            assert.notStrictEqual(
                originalCookies.find(cookie => cookie.name === "sIdRefreshToken"),
                undefined
            );

            await page.evaluate(async () => {
                // Switch to header based auth
                // Re-initialization doesn't work for everything (i.e., overrides), but it's fine for this
                supertokens.init({
                    apiDomain: BASE_URL,
                    tokenTransferMethod: "header"
                });

                let getResponse = await toTest({ url: `${BASE_URL}/`, method: "GET" });

                //check that the response to getSession was success
                assert.strictEqual(getResponse.responseText, userId);

                //check that the number of time the refreshAPI was called is 1
                assert.strictEqual(await getNumberOfTimesRefreshCalled(), 1);
            });

            const refreshedCookies = (await page._client.send("Network.getAllCookies")).cookies;
            assert.strictEqual(
                refreshedCookies.find(cookie => cookie.name === "sIdRefreshToken"),
                undefined
            );

            await page.evaluate(async () => {
                // Make sure this is still undefined because the backend should continue using cookies
                accessToken = await supertokens.getAccessToken();
                assert.strictEqual(accessToken, undefined);

                await supertokens.signOut();

                // send api request to login
                loginResponse = await toTest({
                    url: `${BASE_URL}/login`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ userId })
                });

                assert.strictEqual(loginResponse.responseText, userId);

                // Make sure now access token is present because it should use header based auth
                accessToken = await supertokens.getAccessToken();
                assert.notStrictEqual(accessToken, undefined);
            });
        });

        it("should work fine if the last header is empty", async () => {
            await startST();
            await setup();
            await page.setRequestInterception(true);

            page.on("request", req => {
                const url = req.url();
                if (url === BASE_URL + "/login") {
                    req.respond({
                        statusCode: 200,
                        headers: {
                            "front-token":
                                "eyJ1aWQiOiIwMGUwOTE1MS0xZDZiLTQwY2MtODYzMS1jZTc4YTE1MDg4YWEiLCJhdGUiOjE2NzUzNTE2MzIwNzUsInVwIjp7InN0LWV2Ijp7InYiOnRydWUsInQiOjE2NzUzNDgwMzIwNjZ9fX0=",
                            "test-header": ""
                        },
                        body: "testing-supertokens-website"
                    });
                } else {
                    req.continue();
                }
            });
            await page.evaluate(async () => {
                const userId = "testing-supertokens-website";
                assert.strictEqual(document.cookie, "");
                const loginResponse = await toTest({
                    url: `${BASE_URL}/login`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ userId })
                });

                assert.strictEqual(loginResponse.statusCode, 200);
                assert.strictEqual(loginResponse.responseText, userId);

                assert.notStrictEqual(document.cookie, "");
            });
            await page.setRequestInterception(false);
        });

        it("should log out fine if the last header is an empty access-token", async () => {
            await startST();
            await setup();
            await page.setRequestInterception(true);

            page.on("request", req => {
                const url = req.url();
                if (url === BASE_URL + "/auth/signout") {
                    req.respond({
                        statusCode: 200,
                        headers: {
                            "front-token": "remove",
                            "access-token": ""
                        },
                        body: JSON.stringify({ status: "OK" })
                    });
                } else {
                    req.continue();
                }
            });

            await page.evaluate(async () => {
                const userId = "testing-supertokens-website";
                const loginResponse = await toTest({
                    url: `${BASE_URL}/login`,
                    method: "post",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ userId })
                });

                assert.strictEqual(loginResponse.statusCode, 200);
                assert.strictEqual(loginResponse.responseText, userId);

                assert.strictEqual(await supertokens.doesSessionExist(), true);

                await supertokens.signOut();
                assert.strictEqual(await supertokens.doesSessionExist(), false);
            });
            await page.setRequestInterception(false);
        });
    });
});
