Page({
  data: { isDark: false },

  onLoad() {
    this.setData({ isDark: getApp().globalData.isDark });
  },

  goBack() {
    wx.navigateBack();
  },
});