$w.onReady(function () {
    function getCookie(name) {
      const cookieName = `${name}=`;
      const cookies = document.cookie.split(';');
      for (let cookie of cookies) {
        cookie = cookie.trim();
        if (cookie.startsWith(cookieName)) {
          return decodeURIComponent(cookie.substring(cookieName.length));
        }
      }
      return null;
    }
  
    const cookieData = getCookie('madeiraCheckoutData');
    if (cookieData) {
      try {
        const checkoutData = JSON.parse(cookieData);
        $w('#trackingdata').value = JSON.stringify(checkoutData);
        $w('#trackingdata').hide();  // Hide the field from the buyer
        console.log('Set tracking data in custom field');
      } catch (error) {
        console.error('Error parsing checkout cookie:', error);
      }
    }
  });