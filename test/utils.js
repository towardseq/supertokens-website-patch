import axios from "axios";

module.exports.delay = function(sec) {
    return new Promise(res => setTimeout(res, sec * 1000));
};

module.exports.checkIfIdRefreshIsCleared = function() {
    const ID_COOKIE_NAME = "sIdRefreshToken";
    let value = "; " + document.cookie;
    let parts = value.split("; " + ID_COOKIE_NAME + "=");
    if (parts.length === 2) {
        let last = parts.pop();
        if (last !== undefined) {
            let properties = last.split(";");
            for (let i = 0; i < properties.length; i++) {
                let current = properties[i].replace("'", "");
                if (current.indexOf("Expires=") != -1) {
                    let expiryDateString = current.split("Expires=")[1];
                    let expiryDate = new Date(expiryDateString);
                    let currentDate = new Date();
                    return expiryDate < currentDate;
                }
            }
        }
    }
};

module.exports.getNumberOfTimesRefreshCalled = async function() {
    let instance = axios.create();
    let response = await instance.get("http://localhost:8080/refreshCalledTime");
    return response.data;
};

module.exports.startST = async function() {
    let instance = axios.create();
    let response = await instance.post("http://localhost:8080/startST");
    return response.data;
};
